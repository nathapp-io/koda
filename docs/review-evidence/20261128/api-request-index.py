"""Inspect ApprovalRequest constraints in a private, networkless PostgreSQL 16 instance."""
import json
import os
from pathlib import Path
import subprocess
import time


def docker(*args, stdin=None):
    return subprocess.check_output(["docker", *args], input=stdin, text=True).strip()


def main():
    endpoint = os.environ.get("DOCKER_HOST") or json.loads(
        docker("context", "inspect", docker("context", "show")))[0]["Endpoints"]["docker"]["Host"]
    if not endpoint.startswith("unix://"):
        raise RuntimeError("This fixture requires a local Docker socket")
    db = docker("run", "-d", "--rm", "--pull=never", "--network", "none",
                "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:16")
    try:
        for _ in range(100):
            if subprocess.run(["docker", "exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("PostgreSQL did not start")
        migrations = Path(__file__).resolve().parents[3] / "apps/api/prisma/migrations"
        for name in ("20261104090000_approval_engine", "20261108090000_approval_request_variant",
                     "20261109090000_approval_request_redeem", "20261119120000_approval_request_status_updated_index"):
            docker("exec", "-i", db, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1",
                   stdin=(migrations / name / "migration.sql").read_text())
        catalog = docker("exec", db, "psql", "-At", "-U", "postgres", "-c",
                         """SELECT i.relname, x.indisunique FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
                         WHERE x.indrelid='"ApprovalRequest"'::regclass ORDER BY i.relname""")
        print(catalog)
        assert [r for r in catalog.splitlines() if r.endswith("|t")] == ["ApprovalRequest_pkey|t"]
        assert any("onBehalfOfId_permissionKe_idx|f" in r for r in catalog.splitlines())
    finally:
        docker("stop", "-t", "2", db)


if __name__ == "__main__":
    main()
