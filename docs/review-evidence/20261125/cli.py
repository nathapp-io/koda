"""Offline CLI proofs for review findings 2 and 15–17. Run with Python 3 and Node 24+."""
import json
import os
import subprocess
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
NODE = os.environ.get("KODA_REVIEW_NODE", "node")
PRELOAD = """
const os = require('node:os');
os.homedir = () => process.env.REVIEW_HOME;
require('node:module').syncBuiltinESMExports();
const fixtures = JSON.parse(require('node:fs').readFileSync(process.env.REVIEW_FIXTURES));
globalThis.fetch = async (request) => {
  const url = new URL(request.url);
  if (url.origin !== 'http://review.invalid') throw Error('Unexpected origin');
  const name = process.env.REVIEW_CASE;
  let body;
  if (request.method === 'GET' && url.pathname === '/api/projects/review') {
    body = {ret: 0, data: {id: 'review', slug: 'review'}};
  } else if (url.pathname === '/api/projects/review/kb/documents' &&
      request.method === (['stored', 'unindexed'].includes(name) ? 'POST' : 'GET')) {
    body = fixtures[name];
  }
  if (!body) throw Error('Unexpected request in ' + name + ': ' + request.method + ' ' + url.pathname);
  return Response.json(body, {status: request.method === 'POST' ? 201 : 200});
};
"""


def main():
    with tempfile.TemporaryDirectory(prefix="koda-review-cli-") as tmp:
        stage = Path(tmp)
        fixture = stage / "responses.json"
        env = {"PATH": os.environ["PATH"], "NODE_ENV": "test",
               "TS_NODE_PROJECT": str(ROOT / "apps/api/tsconfig.json")}
        subprocess.run([NODE, "-r", "ts-node/register/transpile-only",
                        str(HERE / "cli-kb-contract.ts"), str(fixture)],
                       cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
        responses = json.loads(fixture.read_text())
        row = responses["one"]["data"][0]
        responses["large"] = {"ret": 0, "data": [
            dict(row, id=str(i), content="x" * 12000) for i in range(100)]}
        fixture.write_text(json.dumps(responses))
        preload = stage / "preload.cjs"
        preload.write_text(PRELOAD)
        project = stage / "project"
        project.mkdir()
        doc = project / "example.md"
        doc.write_text("Review fixture")
        store = stage / ".koda" / "config.json"
        store.parent.mkdir()
        original = {"apiUrl": "http://review.invalid", "apiKey": "review-fixture-key",
                    "profiles": {"review": {"apiUrl": "http://review.invalid",
                                            "apiKey": "review-profile-key"}}}
        store.write_text(json.dumps(original))
        base = [NODE, "--require", str(preload), "--import", "tsx", "apps/cli/src/index.ts"]
        env.update(REVIEW_HOME=tmp, REVIEW_FIXTURES=str(fixture), KODA_PROJECT_SLUG="review")

        def cli(case, args, cwd=project, stdout=subprocess.PIPE):
            return subprocess.run([*base, "--cwd", str(cwd), *args], cwd=ROOT,
                                  env=dict(env, REVIEW_CASE=case), stdout=stdout,
                                  stderr=subprocess.PIPE, timeout=20)

        args = ["kb", "list", "--json"]
        output = stage / "complete.json"
        with output.open("wb") as stream:
            assert cli("large", args, stdout=stream).returncode == 0
        assert len(json.loads(output.read_bytes())) == 100
        # Delay draining to model a slow consumer. A fixed CLI will wait until communicate drains the pipe.
        child = subprocess.Popen([*base, "--cwd", str(project), *args], cwd=ROOT,
                                 env=dict(env, REVIEW_CASE="large"), stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE)
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        piped, errors = child.communicate(timeout=20)
        assert child.returncode == 0, errors
        assert output.read_bytes().startswith(piped) and 0 < len(piped) < output.stat().st_size
        try:
            json.loads(piped)
        except json.JSONDecodeError:
            pass
        else:
            raise AssertionError("Expected incomplete piped JSON")
        print(f"02  exit=0 for file and pipe; file={output.stat().st_size} bytes/100 rows, pipe={len(piped)} bytes/invalid JSON")

        for case in ["empty", "one"]:
            human = cli(case, ["kb", "list"])
            machine = cli(case, args)
            assert human.returncode == 1 and b"data.items is not iterable" in human.stderr
            assert machine.returncode == 0 and json.loads(machine.stdout) == responses[case]["data"]
            print(f"16  {case} API array: human exit=1; JSON exit=0, {len(json.loads(machine.stdout))} rows")

        for case in ["stored", "unindexed"]:
            added = cli(case, ["kb", "add", "--file", str(doc)])
            line = added.stdout.decode().strip()
            assert added.returncode == 0 and "Added example.md" in line and "undefined" in line
            print(f"17  API indexed={responses[case]['data']['indexed']}: exit=0, {line}")

        assert cli("init", ["init", "--project", "review"]).returncode == 0
        assert json.loads(store.read_text()) == original
        assert cli("init", ["init", "--project", "review"], cwd=stage).returncode == 0
        remaining = json.loads(store.read_text())
        assert remaining == {"projectSlug": "review"}
        print("15  init from project preserved the global store; init from fixture home replaced all three fields with projectSlug")


if __name__ == "__main__":
    main()
