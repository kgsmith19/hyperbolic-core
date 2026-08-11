"""Sign in to Supabase Auth and print an access token for lifeos API calls.

Usage: `python scripts/get_token.py`. Reads LIFEOS_SUPABASE_URL and
LIFEOS_SUPABASE_PUBLISHABLE_KEY from the environment or the repo .env,
prompts for the owner's email and password, prints the bearer token.
"""

import getpass
import json
import sys
import urllib.error
import urllib.request

from kernel.env import read_env


def main() -> int:
    base = (read_env("LIFEOS_SUPABASE_URL") or "").rstrip("/")
    key = read_env("LIFEOS_SUPABASE_PUBLISHABLE_KEY")
    if not base or not key:
        print("set LIFEOS_SUPABASE_URL and LIFEOS_SUPABASE_PUBLISHABLE_KEY", file=sys.stderr)
        return 2
    email = input("email: ").strip()
    password = getpass.getpass("password: ")
    request = urllib.request.Request(
        f"{base}/auth/v1/token?grant_type=password",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"apikey": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request) as response:
            body = json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        print(f"sign-in failed ({exc.code}): {detail}", file=sys.stderr)
        return 1
    print(body["access_token"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
