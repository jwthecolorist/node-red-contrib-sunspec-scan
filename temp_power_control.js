// Get flow context values ensures numbers 
const power = Number(flow.get('power')) || 0; 
const soc = Number(flow.get('soc')) || 0;
const vars = Number(flow.get('var')); // Singular 'var'
const hz = Number(flow.get('hz')) || 0;
const voltpha = Number(flow.get('voltpha')) || 0; // Bus Voltage

const now = Date.now();

// =========================================================
// 1. VARS/VOLTAGE SAFETY MONITOR (Priority 1)
// =========================================================
let varsHistory = context.get('varsHistory') || [];
let varsLockoutUntil = context.get('varsLockoutUntil') || 0;

// Update History
if (!isNaN(vars)) {
    varsHistory.push({ value: vars, timestamp: now });
    varsHistory = varsHistory.filter(entry => entry.timestamp >= (now - 60000));
    context.set('varsHistory', varsHistory);
}

// ------------------------------------------
// RULE A: IMMEDIATE HARD LIMIT (+/- 800)
// ------------------------------------------
let hardLimitTrip = false;
if (Math.abs(vars) > 800) {
    hardLimitTrip = true;
    node.warn(`SAFETY TRIP: Vars HARD LIMIT exceeded (${vars}). Lockout 10m.`);
}

// ------------------------------------------
// RULE B: OSCILLATION DETECTION
// ------------------------------------------
let varsMin = 0;
let varsMax = 0;
let isOscillating = false;

if (varsHistory.length > 0) {
    varsMin = varsHistory[0].value;
    varsMax = varsHistory[0].value;
    for (let i = 1; i < varsHistory.length; i++) {
        const v = varsHistory[i].value;
        if (v < varsMin) varsMin = v;
        if (v > varsMax) varsMax = v;
    }
    
    // "Rapid fluctuation negative to positive"
    if (varsMax > 200 && varsMin < -200) {
        isOscillating = true;
    }
}

// ------------------------------------------
// RULE C: CONDITIONAL TRIP (Voltage or Duration)
// ------------------------------------------
let oscillationStartTime = context.get('oscillationStartTime');
let oscillationTrip = false;
let oscillationDuration = 0;

if (isOscillating) {
    // 1. Check Voltage (Immediate)
    if (voltpha > 121) {
        oscillationTrip = true;
        node.warn(`SAFETY TRIP: Oscillation (+${varsMax}/${varsMin}) AND High Voltage (${voltpha}V). Lockout 10m.`);
    } 
    // 2. Check Duration (Persistent)
    else {
        // Voltage is SAFE, but we are oscillating. Start/Check Timer.
        if (!oscillationStartTime) {
            oscillationStartTime = now;
            context.set('oscillationStartTime', oscillationStartTime);
        } else {
            oscillationDuration = (now - oscillationStartTime) / 1000;
            // "If they exceed bounds over 2 minutes"
            if (oscillationDuration > 120) {
                oscillationTrip = true;
                node.warn(`SAFETY TRIP: Oscillation persisted > 2 mins despite safe voltage. Lockout 10m.`);
            }
        }
    }
} else {
    // Reset Timer if oscillation stops
    if (oscillationStartTime) {
        context.set('oscillationStartTime', null);
    }
}


// APPLY LOCKOUT
if ((hardLimitTrip || oscillationTrip) && varsLockoutUntil < now) {
    varsLockoutUntil = now + 600000; // 10 minutes
    context.set('varsLockoutUntil', varsLockoutUntil);
}

// =========================================================
// 2. FREQUENCY SUPPORT (Priority 2 - Grid Support)
// =========================================================
let hzHighStartTime = context.get('hzHighStartTime');
let hzOverrideActive = context.get('hzOverrideActive') || false;
let hzDuration = 0;

if (hz > 60.8) {
    if (!hzHighStartTime) {
        hzHighStartTime = now;
        context.set('hzHighStartTime', hzHighStartTime);
    } else {
        hzDuration = (now - hzHighStartTime) / 1000;
        if (hzDuration > 120) { // > 2 minutes
            hzOverrideActive = true;
            context.set('hzOverrideActive', true);
        }
    }
} else {
    if (hzHighStartTime) {
        context.set('hzHighStartTime', null);
    }
    if (hz < 60.5 && hzOverrideActive) {
        hzOverrideActive = false;
        context.set('hzOverrideActive', false);
    }
}

// =========================================================
// 3. STANDARD LOGIC LOCKOUT (Priority 3)
// =========================================================
let standardLockoutUntil = context.get('standardLockoutUntil') || 0;

if (soc < 85 && power > 600 && now > standardLockoutUntil) {
    standardLockoutUntil = now + 600000; // 10 minutes
    context.set('standardLockoutUntil', standardLockoutUntil);
    node.warn(`STANDARD TRIP: SOC < 85 & Power > 600. Lockout 10m.`);
}

// =========================================================
// 4. DETERMINE TARGET VALUE & STATUS
// =========================================================
let targetValue;
let statusOpts = {};
let detailedText = "";

// Metrics
const metrics = `[Hz:${hz.toFixed(2)} | V:${voltpha.toFixed(1)} | VarRng:${varsMin.toFixed(0)}..${varsMax.toFixed(0)} | SOC:${soc}% | Pwr:${power}]`;

if (now < varsLockoutUntil) {
    // Priority 1: Vars Unsafe
    targetValue = 0;
    const remainingMins = Math.ceil((varsLockoutUntil - now) / 60000);
    statusOpts = {fill:"red", shape:"dot", text:`Vars/Volt Trip: ${remainingMins}m`};
    detailedText = `SHUTDOWN (SAFETY): Vars Trip (Hard Limit or Oscillation). Time left: ${remainingMins}m. ${metrics}`;
} 
else if (hzOverrideActive) {
    // Priority 2: High Hz
    targetValue = 1; 
    statusOpts = {fill:"yellow", shape:"dot", text:`Hz Override: ${hz.toFixed(2)}Hz`};
    detailedText = `FORCED ON (HZ SUPPORT): Freq Override (>60.5Hz). Duration: ${hzDuration.toFixed(0)}s. ${metrics}`;
} 
else if (now < standardLockoutUntil) {
    // Priority 3: Standard Lockout
    targetValue = 0;
    const remainingMins = Math.ceil((standardLockoutUntil - now) / 60000);
    statusOpts = {fill:"red", shape:"ring", text:`Standard Lockout: ${remainingMins}m`};
    detailedText = `SHUTDOWN (STANDARD): Power/SOC Trip Active. Time left: ${remainingMins}m. ${metrics}`;
} 
else {
    // Normal Operation
    targetValue = 1;
    // Show Warning status if Oscillating but Voltage OK
    if (isOscillating) {
        statusOpts = {fill:"yellow", shape:"ring", text:`Oscillation Warning (${oscillationDuration.toFixed(0)}s)`};
        detailedText = `NORMAL ON (WARNING): Vars Oscillating but Voltage Safe. Duration: ${oscillationDuration.toFixed(0)}s (Trip at 120s). ${metrics}`;
    } else {
        statusOpts = {fill:"green", shape:"dot", text:`On | SOC:${soc}%`};
        detailedText = `NORMAL ON: System operating normally. ${metrics}`;
    }
}

// Update Status
node.status(statusOpts);

// =========================================================
// 5. THROTTLING & OUTPUT
// =========================================================
const lastSentValue = context.get('lastSentValue');
const lastWriteTime = context.get('lastWriteTime') || 0;

let shouldWrite = false;

if (lastSentValue === undefined || lastSentValue !== targetValue) {
    shouldWrite = true;
} else if (now - lastWriteTime >= 60000) {
    shouldWrite = true;
}

if (shouldWrite) {
    context.set('lastSentValue', targetValue);
    context.set('lastWriteTime', now);
    
    msg.payload = targetValue;
    msg.control_status = detailedText; 
    msg.topic = "control_logic_update";
    
    return msg;
} else {
    return null;
}