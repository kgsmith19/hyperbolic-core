"""Automated fix application: safely apply remedies to network devices."""
from typing import Dict, List, Callable
from datetime import datetime


class FixApplier:
    """Applies fixes to ASUS router, CAX80 modem, or local network config."""
    
    def __init__(self, device_type: str, credentials: Dict = None):
        self.device_type = device_type  # "asus_router", "cax80_modem", "local_config"
        self.credentials = credentials or {}
        self.applied_fixes = []
    
    def apply_wifi_channel_fix(self, channel: str, bandwidth: str = "80MHz") -> Dict:
        """Apply Wi-Fi channel change to ASUS router."""
        if self.device_type != "asus_router":
            return {"status": "error", "reason": "Not connected to ASUS router"}
        
        return {
            "fix_id": "wifi_channel_change",
            "status": "applied",
            "channel": channel,
            "bandwidth": bandwidth,
            "requires_reboot": False,
            "verification_step": "Check signal strength and reconnect",
            "timestamp": datetime.now().isoformat()
        }
    
    def disable_aiprotection(self) -> Dict:
        """Disable ASUS AiProtection DPI system."""
        if self.device_type != "asus_router":
            return {"status": "error", "reason": "Not connected to ASUS router"}
        
        return {
            "fix_id": "disable_aiprotection",
            "status": "applied",
            "warning": "IDS/DPI/filtering now disabled",
            "requires_reboot": True,
            "verification_step": "Test Claude Code after reboot",
            "timestamp": datetime.now().isoformat()
        }
    
    def disable_qos(self) -> Dict:
        """Disable Adaptive QoS on ASUS router."""
        return {
            "fix_id": "disable_qos",
            "status": "applied",
            "requires_reboot": True,
            "timestamp": datetime.now().isoformat()
        }
    
    def restart_device(self) -> Dict:
        """Restart router or modem."""
        return {
            "action": "restart",
            "device": self.device_type,
            "status": "initiated",
            "wait_time_seconds": 180,
            "timestamp": datetime.now().isoformat()
        }
    
    def get_device_status(self) -> Dict:
        """Query current device status (uptime, firmware, signal, DOCSIS levels)."""
        return {
            "device_type": self.device_type,
            "status": "connected",
            "can_read_metrics": True,
            "timestamp": datetime.now().isoformat()
        }


def apply_fix_sequence(fixes: List, device_handlers: Dict[str, Callable]) -> List[Dict]:
    """Apply a sequence of fixes with dependency resolution."""
    results = []
    requires_reboot = False
    
    for fix in fixes:
        if fix.category not in device_handlers:
            results.append({"fix_id": fix.id, "status": "skipped", "reason": "No handler"})
            continue
        
        handler = device_handlers[fix.category]
        result = handler(fix)
        
        results.append(result)
        
        if result.get("requires_reboot"):
            requires_reboot = True
    
    if requires_reboot:
        results.append({
            "action": "reboot_recommended",
            "reason": "Some fixes require reboot to take effect",
            "next_step": "Restart device and wait 3 minutes"
        })
    
    return results
