#!/usr/bin/env python3
"""Drives pulumilsp like an editor does (initialize → didOpen → didSave) and reports the diagnostics it publishes and
how long after the save they arrived.

  lsp-smoke.py <pulumilsp binary> <program dir> <file in it> [saves]

Lint mode is on when PULUMILSP_LINT_PACKS is set (a path list of policy packs); PULUMILSP_PULUMI picks the CLI.
"""
import json, os, subprocess, sys, threading, time, queue

server, root, path = sys.argv[1], os.path.abspath(sys.argv[2]), os.path.abspath(sys.argv[3])
saves = int(sys.argv[4]) if len(sys.argv) > 4 else 2
uri = "file://" + path
p = subprocess.Popen([server], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=root)
inbox = queue.Queue()


def reader():
    while True:
        headers = {}
        while True:
            line = p.stdout.readline()
            if not line:
                return
            line = line.decode().strip()
            if not line:
                break
            k, v = line.split(":", 1)
            headers[k.lower()] = v.strip()
        n = int(headers["content-length"])
        body = b""
        while len(body) < n:
            chunk = p.stdout.read(n - len(body))
            if not chunk:
                return
            body += chunk
        try:
            inbox.put(json.loads(body))
        except json.JSONDecodeError:
            print("  (unparsable server message)", body[:300], file=sys.stderr)


threading.Thread(target=reader, daemon=True).start()
next_id = [0]


def send(msg):
    b = json.dumps(msg).encode()
    p.stdin.write(f"Content-Length: {len(b)}\r\n\r\n".encode() + b)
    p.stdin.flush()


def request(method, params):
    next_id[0] += 1
    send({"jsonrpc": "2.0", "id": next_id[0], "method": method, "params": params})
    return next_id[0]


def notify(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})


def pump(until, timeout):
    """Handles server traffic until `until(msg)` is true or the timeout passes. Answers server requests."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            m = inbox.get(timeout=max(0.01, deadline - time.time()))
        except queue.Empty:
            break
        if "method" in m and "id" in m:  # a request from the server (workDoneProgress/create, ...)
            send({"jsonrpc": "2.0", "id": m["id"], "result": None})
            continue
        if m.get("method") == "window/logMessage" and os.environ.get("VERBOSE"):
            print("  log:", m["params"]["message"][:1500])
        if until(m):
            return m
    return None


init_id = request("initialize", {"processId": os.getpid(), "rootUri": "file://" + root,
                                 "workspaceFolders": [{"uri": "file://" + root, "name": "program"}],
                                 "capabilities": {"window": {"workDoneProgress": True},
                                                  "textDocument": {"publishDiagnostics": {}}}})
pump(lambda m: m.get("id") == init_id, 30)
notify("initialized", {})
text = open(path).read()
lang = "typescript" if path.endswith(".ts") else "javascript"
notify("textDocument/didOpen", {"textDocument": {"uri": uri, "languageId": lang, "version": 1, "text": text}})

results = []
for i in range(saves):
    t0 = time.time()
    notify("textDocument/didSave", {"textDocument": {"uri": uri}, "text": text})
    m = pump(lambda m: m.get("method") == "textDocument/publishDiagnostics" and m["params"]["uri"] == uri
             and m["params"]["diagnostics"], float(os.environ.get("LSP_TIMEOUT", "300")))
    took = time.time() - t0
    diags = m["params"]["diagnostics"] if m else []
    results.append({"save": i + 1, "seconds": round(took, 2), "diagnostics": len(diags)})
    print(json.dumps(results[-1]))
    if i == 0 and diags:
        for d in diags[:5]:
            print(f"  L{d['range']['start']['line'] + 1}:{d['range']['start']['character'] + 1} "
                  f"sev={d.get('severity')} {d.get('source')}: {d['message'].splitlines()[-1][:110]}")
p.kill()
