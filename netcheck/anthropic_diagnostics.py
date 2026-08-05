"""Anthropic status diagnostics: check for service degradation.

Covers hypothesis #8: Anthropic-side incident/degraded performance.
"""
import json
from typing import Dict, Optional
from urllib.request import urlopen
from datetime import datetime


def check_anthropic_status() -> Dict:
    """Check Anthropic service status via status page."""
    try:
        response = urlopen("https://status.anthropic.com/api/v2/status.json", timeout=5)
        data = json.loads(response.read().decode())

        status = data.get('status', {}).get('description', 'unknown')
        indicator = data.get('status', {}).get('indicator', 'unknown')

        return {
            'accessible': True,
            'status': status,
            'indicator': indicator,
            'degraded': indicator in ['degraded_performance', 'partial_outage', 'major_outage'],
            'timestamp': datetime.now().isoformat(),
        }
    except Exception as e:
        return {
            'accessible': False,
            'error': str(e),
            'degraded': None,
            'timestamp': datetime.now().isoformat(),
        }


def check_api_endpoint(endpoint: str = "https://api.anthropic.com/v1/models") -> Dict:
    """Check if Anthropic API endpoints are responding."""
    try:
        response = urlopen(endpoint, timeout=5)
        return {
            'reachable': True,
            'status_code': response.status,
            'response_time_ms': 'unknown',
        }
    except Exception as e:
        return {
            'reachable': False,
            'error': str(e),
        }


class AnthropicDiagnostics:
    """Diagnose Anthropic-side issues (#8)."""

    def __init__(self):
        self.id = "anthropic_status"
        self.name = "Anthropic Service Health"

    def check_service_status(self) -> Dict:
        """Check Anthropic status page for incidents."""
        result = check_anthropic_status()
        return {
            'status_page_accessible': result.get('accessible'),
            'service_degraded': result.get('degraded'),
            'indicator': result.get('indicator'),
            'status': result.get('status'),
            'explanation': (
                'Anthropic reporting service degradation. Check status page for updates.'
                if result.get('degraded')
                else 'Anthropic services appear normal'
            ),
        }

    def check_api_connectivity(self) -> Dict:
        """Check if API endpoints are reachable."""
        result = check_api_endpoint()
        return {
            'api_reachable': result.get('reachable'),
            'status_code': result.get('status_code'),
            'explanation': (
                'API endpoint unreachable. May indicate ISP block, firewall, or service issue.'
                if not result.get('reachable')
                else 'API connectivity normal'
            ),
        }

    def check_incident_history(self) -> Dict:
        """Check for recent incidents (from status page)."""
        try:
            response = urlopen("https://status.anthropic.com/api/v2/incidents.json", timeout=5)
            data = json.loads(response.read().decode())
            incidents = data.get('incidents', [])

            recent = [inc for inc in incidents if inc.get('status') in ['investigating', 'identified', 'monitoring']]

            return {
                'recent_incidents': len(recent),
                'incidents': recent[:3],  # Last 3
                'explanation': (
                    f'{len(recent)} incidents currently being addressed'
                    if recent
                    else 'No recent incidents'
                ),
            }
        except Exception:
            return {
                'recent_incidents': None,
                'explanation': 'Could not fetch incident history',
            }
