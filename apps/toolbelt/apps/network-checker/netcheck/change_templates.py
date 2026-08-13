"""Enabled, exactly reversible change templates.

No write template is currently enabled. The legacy DNS, Wi-Fi-mode, and
adapter-power scripts are disabled stubs because they cannot prove an exact
pre-state restore. A future entry must use allow-listed argv, carry a verified
inverse, and have bounded verification that proves the intended state.
"""

TEMPLATES = {}
