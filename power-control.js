/**
 * mg-power-control — Extensible Power Control Node for Node-RED
 * 
 * A configurable, rule-engine-based power control node for microgrid
 * battery/inverter dispatch. Each protection layer is a "rule" evaluated 
 * in priority order. New rule types can be added by registering a handler.
 * 
 * Architecture:
 *   - RULE_HANDLERS: extensible map of rule type → handler function
 *   - Each handler: (ctx, config, state) → { tripped, action, reason, status }
 *   - Rules evaluated top-to-bottom; first trip wins
 *   - Output throttled: change-only + heartbeat interval
 */
module.exports = function (RED) {

    // =========================================================================
    // RULE HANDLER REGISTRY
    // =========================================================================
    // To add a new rule type:
    //   1. Add an entry to RULE_HANDLERS with a handler function
    //   2. Add a matching entry to RULE_TYPES for the editor UI metadata
    //   3. The editor will auto-discover the type from the dropdown
    // =========================================================================

    const RULE_TYPES = {
        var_safety: {
            label: "VAr / Voltage Safety",
            description: "Trips on reactive power hard limits or oscillation",
            icon: "⚡",
            defaults: {
                limit: 800,        // VAr hard limit (absolute)
                window: 60,        // Oscillation detection window (seconds)
                swing: 200,        // Min/max swing threshold (VAr)
                voltThreshold: 121, // Voltage coupling threshold (V)
                persistSec: 120,   // Oscillation persistence before trip (seconds)
                lockout: 600       // Lockout duration (seconds)
            }
        },
        freq_support: {
            label: "Frequency Support",
            description: "Forces ON when grid frequency is high (Hz override)",
            icon: "〜",
            defaults: {
                triggerHz: 60.8,   // Activate above this Hz
                sustainSec: 120,   // Duration above trigger before override
                clearHz: 60.5      // Deactivate below this Hz
            }
        },
        power_soc: {
            label: "Power / SOC Lockout",
            description: "Shuts down when SOC is low and power draw is high",
            icon: "🔋",
            defaults: {
                socThreshold: 85,    // SOC below this (%)
                powerThreshold: 600, // Power above this (W)
                lockout: 600         // Lockout duration (seconds)
            }
        },
        voltage: {
            label: "Voltage Guard",
            description: "Trips on over-voltage or under-voltage conditions",
            icon: "🔌",
            defaults: {
                highV: 132,   // Over-voltage trip (V)
                lowV: 106,    // Under-voltage trip (V)
                lockout: 300  // Lockout duration (seconds)
            }
        }
    };

    // =========================================================================
    // RULE HANDLER IMPLEMENTATIONS
    // =========================================================================
    //
    // Each handler receives:
    //   ctx    — { power, soc, var, hz, volt, now }
    //   config — user-configured thresholds for this rule  
    //   state  — mutable persistent state object for this rule instance
    //
    // Must return:
    //   { tripped: bool, action: number, reason: string, statusOpts: {fill, shape, text} }
    // =========================================================================

    const RULE_HANDLERS = {

        // -----------------------------------------------------------------
        // VAr / Voltage Safety (Priority: Critical)
        // Hard limit check + oscillation detection with voltage coupling
        // -----------------------------------------------------------------
        var_safety: function (ctx, config, state) {
            const { var: vars, volt, now } = ctx;
            const limit = Number(config.limit) || 800;
            const window = (Number(config.window) || 60) * 1000;
            const swing = Number(config.swing) || 200;
            const voltThreshold = Number(config.voltThreshold) || 121;
            const persistSec = Number(config.persistSec) || 120;
            const lockoutMs = (Number(config.lockout) || 600) * 1000;

            // Initialize state
            if (!state.varsHistory) state.varsHistory = [];
            if (!state.lockoutUntil) state.lockoutUntil = 0;

            // Update rolling history
            if (!isNaN(vars)) {
                state.varsHistory.push({ value: vars, timestamp: now });
                state.varsHistory = state.varsHistory.filter(e => e.timestamp >= (now - window));
            }

            // --- RULE A: Hard Limit ---
            let hardTrip = false;
            if (Math.abs(vars) > limit) {
                hardTrip = true;
            }

            // --- RULE B: Oscillation Detection ---
            let varsMin = 0, varsMax = 0, isOscillating = false;
            if (state.varsHistory.length > 0) {
                varsMin = state.varsHistory[0].value;
                varsMax = state.varsHistory[0].value;
                for (let i = 1; i < state.varsHistory.length; i++) {
                    const v = state.varsHistory[i].value;
                    if (v < varsMin) varsMin = v;
                    if (v > varsMax) varsMax = v;
                }
                if (varsMax > swing && varsMin < -swing) {
                    isOscillating = true;
                }
            }

            // --- RULE C: Conditional Trip ---
            let oscillationTrip = false;
            let oscillationDuration = 0;

            if (isOscillating) {
                // Immediate trip if voltage is also high
                if (volt > voltThreshold) {
                    oscillationTrip = true;
                } else {
                    // Track persistence
                    if (!state.oscillationStart) {
                        state.oscillationStart = now;
                    } else {
                        oscillationDuration = (now - state.oscillationStart) / 1000;
                        if (oscillationDuration > persistSec) {
                            oscillationTrip = true;
                        }
                    }
                }
            } else {
                state.oscillationStart = null;
            }

            // Apply lockout
            if ((hardTrip || oscillationTrip) && state.lockoutUntil < now) {
                state.lockoutUntil = now + lockoutMs;
            }

            // Check active lockout
            if (now < state.lockoutUntil) {
                const remainMin = Math.ceil((state.lockoutUntil - now) / 60000);
                const triggerType = hardTrip ? 'Hard Limit' : 'Oscillation';
                return {
                    tripped: true,
                    action: 0,
                    reason: `SHUTDOWN (VAR SAFETY): ${triggerType} trip. Lockout: ${remainMin}m. [Var:${varsMin.toFixed(0)}..${varsMax.toFixed(0)} | V:${(volt || 0).toFixed(1)}]`,
                    statusOpts: { fill: "red", shape: "dot", text: `VAr Trip: ${remainMin}m` }
                };
            }

            return { tripped: false };
        },

        // -----------------------------------------------------------------
        // Frequency Support (Priority: Grid Support)
        // Force inverter ON during high-frequency events
        // -----------------------------------------------------------------
        freq_support: function (ctx, config, state) {
            const { hz, now } = ctx;
            const triggerHz = Number(config.triggerHz) || 60.8;
            const sustainSec = Number(config.sustainSec) || 120;
            const clearHz = Number(config.clearHz) || 60.5;

            if (!state.overrideActive) state.overrideActive = false;
            let hzDuration = 0;

            if (hz > triggerHz) {
                if (!state.highStart) {
                    state.highStart = now;
                } else {
                    hzDuration = (now - state.highStart) / 1000;
                    if (hzDuration > sustainSec) {
                        state.overrideActive = true;
                    }
                }
            } else {
                state.highStart = null;
                if (hz < clearHz && state.overrideActive) {
                    state.overrideActive = false;
                }
            }

            if (state.overrideActive) {
                return {
                    tripped: true,
                    action: 1, // FORCE ON
                    reason: `FORCED ON (HZ SUPPORT): Freq override (${hz.toFixed(2)}Hz > ${triggerHz}Hz). Duration: ${hzDuration.toFixed(0)}s.`,
                    statusOpts: { fill: "yellow", shape: "dot", text: `Hz Override: ${hz.toFixed(2)}Hz` }
                };
            }

            return { tripped: false };
        },

        // -----------------------------------------------------------------
        // Power / SOC Lockout (Priority: Standard Protection)
        // Shutdown when battery is low and power draw is high
        // -----------------------------------------------------------------
        power_soc: function (ctx, config, state) {
            const { power, soc, now } = ctx;
            const socThreshold = Number(config.socThreshold) || 85;
            const powerThreshold = Number(config.powerThreshold) || 600;
            const lockoutMs = (Number(config.lockout) || 600) * 1000;

            if (!state.lockoutUntil) state.lockoutUntil = 0;

            // Trip condition
            if (soc < socThreshold && power > powerThreshold && now > state.lockoutUntil) {
                state.lockoutUntil = now + lockoutMs;
            }

            if (now < state.lockoutUntil) {
                const remainMin = Math.ceil((state.lockoutUntil - now) / 60000);
                return {
                    tripped: true,
                    action: 0,
                    reason: `SHUTDOWN (STANDARD): SOC ${soc}% < ${socThreshold}% AND Power ${power}W > ${powerThreshold}W. Lockout: ${remainMin}m.`,
                    statusOpts: { fill: "red", shape: "ring", text: `Lockout: ${remainMin}m` }
                };
            }

            return { tripped: false };
        },

        // -----------------------------------------------------------------
        // Voltage Guard (Priority: Equipment Protection)
        // Over/under voltage trip
        // -----------------------------------------------------------------
        voltage: function (ctx, config, state) {
            const { volt, now } = ctx;
            const highV = Number(config.highV) || 132;
            const lowV = Number(config.lowV) || 106;
            const lockoutMs = (Number(config.lockout) || 300) * 1000;

            if (!state.lockoutUntil) state.lockoutUntil = 0;

            if (volt !== undefined && volt !== null) {
                if ((volt > highV || volt < lowV) && now > state.lockoutUntil) {
                    state.lockoutUntil = now + lockoutMs;
                    state.tripReason = volt > highV ? 'Over-Voltage' : 'Under-Voltage';
                }
            }

            if (now < state.lockoutUntil) {
                const remainMin = Math.ceil((state.lockoutUntil - now) / 60000);
                return {
                    tripped: true,
                    action: 0,
                    reason: `SHUTDOWN (VOLTAGE): ${state.tripReason || 'Trip'} (${(volt || 0).toFixed(1)}V). Lockout: ${remainMin}m.`,
                    statusOpts: { fill: "red", shape: "dot", text: `${state.tripReason}: ${remainMin}m` }
                };
            }

            return { tripped: false };
        }
    };


    // =========================================================================
    // NODE CONSTRUCTOR
    // =========================================================================

    function PowerControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // --- Configuration ---
        node.name = config.name || '';
        node.defaultAction = Number(config.defaultAction) || 1;
        node.heartbeatInterval = (Number(config.heartbeatInterval) || 60) * 1000;

        // Context variable sources
        node.inputs = {
            power:  { type: config.powerVarType  || 'flow', value: config.powerVar  || 'power' },
            soc:    { type: config.socVarType    || 'flow', value: config.socVar    || 'soc' },
            var:    { type: config.varVarType    || 'flow', value: config.varVar    || 'var' },
            hz:     { type: config.hzVarType     || 'flow', value: config.hzVar     || 'hz' },
            volt:   { type: config.voltVarType   || 'flow', value: config.voltVar   || 'voltpha' },
        };

        // Rules array from editor
        node.rules = config.rules || [];

        // --- Runtime State ---
        // Persistent state per rule (keyed by index)
        const ruleStates = {};
        node.rules.forEach((rule, i) => {
            ruleStates[i] = node.context().get(`ruleState_${i}`) || {};
        });

        // Throttling state
        let lastSentValue = undefined;
        let lastWriteTime = 0;

        // --- Helper: Read a context variable ---
        function readInput(key) {
            const input = node.inputs[key];
            if (!input) return undefined;

            if (input.type === 'flow') {
                return node.context().flow.get(input.value);
            } else if (input.type === 'global') {
                return node.context().global.get(input.value);
            } else if (input.type === 'num') {
                return Number(input.value);
            } else if (input.type === 'msg') {
                return input.value; // Will be resolved from msg at call time
            }
            return undefined;
        }

        // --- Helper: Read all inputs, resolving msg properties ---
        function readAllInputs(msg) {
            const ctx = { now: Date.now() };
            for (const key of Object.keys(node.inputs)) {
                const input = node.inputs[key];
                if (input.type === 'msg') {
                    ctx[key] = Number(RED.util.getMessageProperty(msg, input.value)) || 0;
                } else {
                    ctx[key] = Number(readInput(key)) || 0;
                }
            }
            return ctx;
        }

        // --- Core: Evaluate all rules ---
        function evaluate(msg) {
            const ctx = readAllInputs(msg);
            const now = ctx.now;

            let result = null;

            for (let i = 0; i < node.rules.length; i++) {
                const rule = node.rules[i];

                // Skip disabled rules
                if (rule.enabled === false) continue;

                const handler = RULE_HANDLERS[rule.type];
                if (!handler) {
                    node.warn(`Unknown rule type: ${rule.type} (rule ${i + 1})`);
                    continue;
                }

                // Ensure state object exists
                if (!ruleStates[i]) ruleStates[i] = {};

                const ruleResult = handler(ctx, rule.config || {}, ruleStates[i]);

                // Persist state
                node.context().set(`ruleState_${i}`, ruleStates[i]);

                if (ruleResult.tripped) {
                    result = ruleResult;
                    break; // First trip wins
                }
            }

            // --- Determine output ---
            let targetValue, statusOpts, reason;

            if (result) {
                targetValue = result.action;
                statusOpts = result.statusOpts;
                reason = result.reason;
            } else {
                // No rules tripped — normal operation
                targetValue = node.defaultAction;
                statusOpts = { fill: "green", shape: "dot", text: `Normal | SOC:${ctx.soc}%` };
                reason = `NORMAL: No rules tripped. [P:${ctx.power}W | SOC:${ctx.soc}% | Hz:${ctx.hz.toFixed(2)} | V:${ctx.volt.toFixed(1)}]`;
            }

            // Update node status
            node.status(statusOpts);

            // --- Throttling ---
            let shouldSend = false;

            if (lastSentValue === undefined || lastSentValue !== targetValue) {
                shouldSend = true;
            } else if (now - lastWriteTime >= node.heartbeatInterval) {
                shouldSend = true;
            }

            if (shouldSend) {
                lastSentValue = targetValue;
                lastWriteTime = now;

                msg.payload = targetValue;
                msg.control_status = reason;
                msg.topic = 'power_control';
                msg.metrics = {
                    power: ctx.power,
                    soc: ctx.soc,
                    var: ctx.var,
                    hz: ctx.hz,
                    volt: ctx.volt
                };

                return msg;
            }

            return null; // Throttled — don't send
        }

        // --- Input Listener ---
        node.on('input', function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };

            try {
                const result = evaluate(msg);
                if (result) {
                    send(result);
                }
                if (done) done();
            } catch (err) {
                node.error(`Power Control error: ${err.message}`, msg);
                node.status({ fill: "red", shape: "dot", text: "Error" });
                if (done) done(err);
            }
        });

        // --- Cleanup ---
        node.on('close', function () {
            node.status({});
        });
    }

    RED.nodes.registerType('mg-power-control', PowerControlNode);

    // --- Expose rule types metadata to the editor ---
    RED.httpAdmin.get('/mg-power-control/rule-types', function (req, res) {
        res.json(RULE_TYPES);
    });
};
