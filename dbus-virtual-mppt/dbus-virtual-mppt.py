#!/usr/bin/env python3
"""
Virtual DBUS Solar Charger for Venus OS
Allows Node-RED (via MQTT/DBus) to inject raw DC power values and simulate
an active solar charger to natively correct the "Total solar" dashboard metric.

Author: Antigravity AI
"""

import sys, os, time, logging
import dbus
from gi.repository import GLib
from dbus.mainloop.glib import DBusGMainLoop

sys.path.insert(1, "/opt/victronenergy/dbus-systemcalc-py/ext/velib_python")
from vedbus import VeDbusService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("virtual-mppt")

class VirtualMPPT:
    def __init__(self):
        self.svc = None
        self._mainloop = None
        self.last_update = time.time()
        # Fallback values if node-red fails to send voltage (usually standard 48V system)
        self.system_voltage = 52.0

    def _handle_write(self, path, value):
        """Callback invoked whenever DBUS value is altered externally (e.g. by Node-RED)."""
        try:
            val = float(value)
            
            # Watchdog reset
            self.last_update = time.time()

            # If node-red sends Power, compute Current automatically based on current Voltage
            if path == "/Dc/0/Power":
                v = self.svc["/Dc/0/Voltage"] or self.system_voltage
                self.svc["/Dc/0/Current"] = round(val / v, 2)
                self.svc["/Yield/Power"] = val
                log.info(f"Node-RED injected Power: {val}W")
                
            elif path == "/Dc/0/Current":
                v = self.svc["/Dc/0/Voltage"] or self.system_voltage
                self.svc["/Dc/0/Power"] = round(val * v)
                self.svc["/Yield/Power"] = round(val * v)

            # Accept the write locally
            return True
        except Exception as e:
            log.warning(f"Failed to process write to {path}: {e}")
            return False

    def _watchdog(self):
        """GLib timer running every 5 seconds to ensure Node-RED is still alive."""
        if time.time() - self.last_update > 60:
            # If Node-RED hasn't sent telemetry in 60s, ZERO the power to prevent stale ghosts
            if self.svc["/Dc/0/Power"] != 0:
                log.warning("Node-RED watchdog timeout (>60s). Zeroing Solar Power.")
                self.svc["/Dc/0/Power"] = 0
                self.svc["/Dc/0/Current"] = 0
                self.svc["/Yield/Power"] = 0
        return True

    def setup(self):
        self.svc = VeDbusService("com.victronenergy.solarcharger.virtual_0", bus=dbus.SystemBus())

        self.svc.add_path("/Mgmt/ProcessName", __file__)
        self.svc.add_path("/Mgmt/ProcessVersion", "1.0.0")
        self.svc.add_path("/Mgmt/Connection", "Node-RED Virtual Interface")
        
        # 100 identifies it as a generic Modbus/Network MPPT in some contexts
        self.svc.add_path("/ProductId", 0xFFFF) 
        self.svc.add_path("/ProductName", "Node-RED Virtual MPPT")
        self.svc.add_path("/CustomName", "Virtual MPPT (Unmonitored)")
        self.svc.add_path("/DeviceInstance", 250)
        self.svc.add_path("/FirmwareVersion", 1)
        self.svc.add_path("/Serial", "VIRTUAL-MPPT-001")
        self.svc.add_path("/Connected", 1)
        
        self.svc.add_path("/State", 3) # 3 = Bulk charging

        # Make the critical metrics WRITABLE natively from dbus so node-red can push to them
        self.svc.add_path("/Dc/0/Voltage", self.system_voltage, writeable=True, onchangecallback=self._handle_write)
        self.svc.add_path("/Dc/0/Current", 0.0, writeable=True, onchangecallback=self._handle_write)
        self.svc.add_path("/Dc/0/Power", 0.0, writeable=True, onchangecallback=self._handle_write)
        self.svc.add_path("/Yield/Power", 0.0, writeable=True, onchangecallback=self._handle_write)

        self.svc.register()
        log.info("Virtual MPPT DBUS service successfully registered: com.victronenergy.solarcharger.virtual_0")

    def run(self):
        DBusGMainLoop(set_as_default=True)
        self.setup()
        
        # GLib timeout for watchdog
        GLib.timeout_add(5000, self._watchdog)
        
        self._mainloop = GLib.MainLoop()
        self._mainloop.run()

if __name__ == "__main__":
    try:
        VirtualMPPT().run()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        log.critical("Virtual MPPT crashed", exc_info=True)
        sys.exit(1)
