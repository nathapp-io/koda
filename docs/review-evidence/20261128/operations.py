"""Offline checks for findings 14–16. Run from a checkout with Bun, Turbo and Docker Compose installed."""
import fnmatch
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]


def run(argv, cwd, env=None, **kwargs):
    return subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True, check=True, **kwargs).stdout.strip()


def workflow(name):
    path = ROOT / ".github/workflows" / name
    return json.loads(run(["ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV[0]))", str(path)], ROOT))


def step(job, field, value):
    return next(s for s in job["steps"] if s.get(field) == value)


def git(directory, *args):
    return run(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture",
                "-c", "user.email=fixture@example.invalid", *args], directory)


def stub(path, script):
    path.write_text("#!/bin/sh\n" + script + "\n")
    path.chmod(0o755)


def ci(directory):
    directory.mkdir()
    jobs = workflow("ci.yml")
    push = jobs.get("on", jobs.get("true"))["push"]["paths"]
    probe = step(jobs["jobs"]["changes"], "id", "filter")["run"]
    git(directory, "init", "-q")
    patches = list(json.loads((ROOT / "package.json").read_text())["patchedDependencies"].values())
    files = [*patches, "apps/runner/src/version.ts", "README.md"]
    for filename in files + ["package.json", "bun.lock", "turbo.json"]:
        dest = directory / filename
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / filename, dest)
    for manifest in [*ROOT.glob("apps/*/package.json"), *ROOT.glob("packages/*/package.json")]:
        dest = directory / manifest.relative_to(ROOT)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(manifest, dest)
    git(directory, "add", ".")
    git(directory, "commit", "-qm", "baseline")
    def runner_hash():
        raw = run([str(ROOT / "node_modules/.bin/turbo"), "run", "test", "--filter=@nathapp/koda-runner",
                   "--dry=json"], directory)
        return next(task["hash"] for task in json.loads(raw)["tasks"] if task["taskId"]=="@nathapp/koda-runner#test")
    for name in files:
        before = runner_hash()
        path = directory / name
        with path.open("a") as f:
            f.write("\n")
        git(directory, "add", name)
        git(directory, "commit", "-qm", "change one file")
        out = directory.parent / "ci-outputs"
        out.write_text("")
        run(["bash", "-e", "-c", probe], directory,
            {**os.environ, "EVENT_NAME":"pull_request", "BASE_SHA":"HEAD~1", "HEAD_SHA":"HEAD", "GITHUB_OUTPUT":str(out)})
        classified = out.read_text().strip()
        matches_push = any(fnmatch.fnmatchcase(name, pattern) for pattern in push)
        hash_changed = runner_hash()!=before
        app = name.startswith("apps/")
        assert (classified, matches_push) == ("code=true" if app else "code=false", app)
        if app:
            assert hash_changed
        print(f"14 {name}: PR {classified}, main push {matches_push}, runner test hash changed {hash_changed}")


def release(directory):
    directory.mkdir()
    jobs = workflow("release.yml")["jobs"]
    bin_dir = directory / "bin"
    bin_dir.mkdir()
    stub(bin_dir / "git", """[ "$1" = ls-remote ] || exit 71
printf '%s\n' 'abc	refs/tags/v0.5.0-canary.1' 'def	refs/tags/v0.5.0-canary.2' 'ghi	refs/tags/v0.5.0' 'jkl	refs/tags/v0.5.1'""")
    stub(bin_dir / "npm", '[ "$1" = view ] || exit 72\nexit 0')
    stub(bin_dir / "docker", """case "$3" in
  create) printf '%s\n' "$@" >> "$DOCKER_CALLS";;
  inspect) printf '%s\n' '{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}';;
  *) exit 73;;
esac""")
    digests = directory / "digests"
    digests.mkdir()
    for digest in ["a"*64, "b"*64]:
        (digests / digest).touch()
    out = directory / "output"
    calls = directory / "docker-calls"
    env = {**os.environ, "PATH":str(bin_dir)+":"+os.environ["PATH"], "GITHUB_OUTPUT":str(out),
           "DIGESTS_DIR":str(digests), "DOCKER_CALLS":str(calls)}
    def bash(body, extra):
        out.write_text("")
        run(["bash","-e","-c",body], directory, {**env, **extra})
        return dict(line.split("=",1) for line in out.read_text().splitlines())
    for tag in ["v0.5.0-canary.1","v0.5.0-canary.2","v0.5.0"]:
        channels = bash(step(jobs["info"],"id","channels")["run"], {"TAG":tag, "VERSION":tag[1:]})
        published = bash(step(jobs["cli"],"id","npm")["run"], {"VERSION":tag[1:]})
        publish = step(jobs["cli"],"name","Publish to npm")
        assert published["published"] == "true" and publish["if"] == "steps.npm.outputs.published != 'true'"
        calls.write_text("")
        for app in ["api","web"]:
            bash(step(jobs["docker"],"id","merge")["run"], {"IMAGE":"docker.io/nathapp/koda-"+app,
                 "TAGS":channels["tags_"+app]})
        aliases = [line for line in calls.read_text().splitlines() if line.startswith("nathapp/")]
        assert aliases == ["nathapp/koda-"+app+(":canary" if "canary" in tag else ":v0.5.0") for app in ["api","web"]]
        print(f"15 {tag} already published: npm skipped; Docker merge tags {', '.join(aliases)}")


def deployment(directory):
    directory.mkdir()
    for name in ["deploy.sh", "docker-compose.yml"]:
        shutil.copy(ROOT / "deployments/example" / name, directory / name)
    env = {k:v for k,v in os.environ.items() if not k.startswith(("POSTGRES_", "COMPOSE_"))}
    env.update({k:"synthetic"*6 for k in ["JWT_SECRET","JWT_REFRESH_SECRET","API_KEY_SECRET"]})
    bin_dir = directory / "bin"
    bin_dir.mkdir()
    marker = directory / "config-called"
    stub(bin_dir / "docker", 'printf "%s\n" "$*" > "$PROBE_CALL"; exit 79')
    for declaration, shell_override, accepted in [
        ("POSTGRES_PASSWORD=fixture-safe", None, True),
        ("export POSTGRES_PASSWORD=fixture-safe", None, False),
        ("export POSTGRES_PASSWORD=fixture-safe", "fixture-override", True),
    ]:
        (directory / ".env").write_text(declaration+"\n")
        effective_env = {**env, **({"POSTGRES_PASSWORD":shell_override} if shell_override else {})}
        rendered = json.loads(run(["docker","compose","config","--format","json"],directory,effective_env))
        value = rendered["services"]["postgres"]["environment"]["POSTGRES_PASSWORD"]
        assert value == (shell_override or "fixture-safe")
        marker.unlink(missing_ok=True)
        result = subprocess.run(["bash", "deploy.sh", "--no-backup"],cwd=directory,
                                env={**effective_env,"PATH":str(bin_dir)+":"+env["PATH"], "PROBE_CALL":str(marker)},
                                capture_output=True, text=True)
        if accepted:
            assert result.returncode == 79 and marker.read_text().strip().endswith(" config")
        else:
            assert result.returncode == 1 and "POSTGRES_PASSWORD must" in result.stdout and not marker.exists()
        print(f"16 {declaration.split('=')[0]}, shell override={bool(shell_override)}: Compose read value, preflight accepted={accepted}")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="koda-ops-review-") as temp:
        root = Path(temp)
        ci(root / "ci")
        release(root / "release")
        deployment(root / "koda-deploy")
