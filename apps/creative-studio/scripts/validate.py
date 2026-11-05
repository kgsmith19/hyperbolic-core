#!/usr/bin/env python3
import json
from pathlib import Path
root = Path(__file__).resolve().parents[1]
for filename, key in [('tools.json', 'tools'), ('concepts.json', 'concepts')]:
    data = json.loads((root / 'registry' / filename).read_text())
    entries = data[key]
    ids = [item['id'] for item in entries]
    assert len(ids) == len(set(ids)), f'duplicate ids: {filename}'
    assert all(item.get('name') for item in entries)
    if key == 'tools':
        assert all(item.get('url', '').startswith('https://') for item in entries)
json.loads((root / 'registry/style-vocabulary.json').read_text())
print('Registry validation passed')
