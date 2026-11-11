#!/usr/bin/env python3
# Test stand-in for secret_scan.py's `--git-staged` and `--stdin [--name N]` modes: same contract (exit 1 on a finding,
# `path:line: KIND` on stdout, never the value). Flags the literal marker FAKESECRET_ followed by 8 upper-case letters or digits.
import re, subprocess, sys
if sys.argv[1:2] == ["--stdin"]:
    name = sys.argv[sys.argv.index("--name") + 1] if "--name" in sys.argv else "<stdin>"
    bad = 0
    for n, line in enumerate(sys.stdin.read().splitlines(), 1):
        if re.search(r"FAKESECRET_[A-Z0-9]{8}", line):
            print("%s:%d: FAKE_SECRET" % (name, n))
            bad = 1
    sys.exit(bad)
assert sys.argv[1:2] == ["--git-staged"], sys.argv
files = subprocess.run(["git", "diff", "--cached", "--name-only", "-z"], capture_output=True, text=True, check=True).stdout.split("\0")[:-1]
bad = 0
for f in files:
    text = subprocess.run(["git", "show", ":" + f], capture_output=True, text=True, check=True).stdout
    for n, line in enumerate(text.splitlines(), 1):
        if re.search(r"FAKESECRET_[A-Z0-9]{8}", line):
            print("%s:%d: FAKE_SECRET" % (f, n))
            bad = 1
sys.exit(bad)
