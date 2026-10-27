"""First-start setup for the Peyvand stack, run by the `init` service before anything else starts.

Creates every config, secret and key under /data from the templates and the .env settings.
Files that already exist are kept, so secrets are generated only once and manual edits survive.
"""

import base64
import os
import secrets
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from signedjson.key import generate_signing_key, write_signing_keys

DATA = Path("/data")
TEMPLATES = Path("/templates")
SYNAPSE_UID = 991


def require(name):
    value = os.environ.get(name, "").strip()
    if not value or "example.com" in value:
        sys.exit(f"init: set {name} in .env (see .env.example)")
    return value


settings = {
    "APP_DOMAIN": require("APP_DOMAIN"),
    "MATRIX_DOMAIN": require("MATRIX_DOMAIN"),
    "ADMIN_EMAIL": os.environ.get("ADMIN_EMAIL", "").strip() or f"admin@{os.environ['MATRIX_DOMAIN']}",
    "PUSH_APP_ID": os.environ.get("PUSH_APP_ID", "").strip() or "com.example.peyvand.web",
}
# The call relay is reached by IP when given: a CDN in front of the domain wouldn't pass its UDP traffic
public_ip = os.environ.get("PUBLIC_IP", "").strip()
settings["TURN_HOST"] = public_ip or settings["MATRIX_DOMAIN"]


def report(path, created):
    print(f"init: {'created' if created else 'kept   '} {path.relative_to(DATA)}")


def write_once(path, make_content, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        report(path, False)
        return path.read_text().strip()
    content = make_content()
    path.write_text(content)
    path.chmod(mode)
    report(path, True)
    return content.strip()


def render(template_name, values):
    content = (TEMPLATES / template_name).read_text()
    for name, value in values.items():
        content = content.replace("{{" + name + "}}", value)
    return content


def make_vapid_key():
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ).decode()


def vapid_public_key(pem):
    key = serialization.load_pem_private_key(pem.encode(), password=None)
    point = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint,
    )
    return base64.urlsafe_b64encode(point).decode().rstrip("=")


def make_signing_key():
    import io

    out = io.StringIO()
    write_signing_keys(out, [generate_signing_key("a_" + secrets.token_hex(2))])
    return out.getvalue()


def chown_tree(path, uid):
    for root, dirs, files in os.walk(path):
        os.chown(root, uid, uid)
        for name in files:
            os.chown(os.path.join(root, name), uid, uid)


# Database
postgres_password = write_once(DATA / "secrets/postgres_password", lambda: secrets.token_hex(32), 0o644)
turn_secret = write_once(DATA / "secrets/turn_secret", lambda: secrets.token_hex(32), 0o600)

# Synapse
synapse_dir = DATA / "synapse"
write_once(synapse_dir / "homeserver.yaml", lambda: render("homeserver.yaml.tmpl", {
    **settings,
    "POSTGRES_PASSWORD": postgres_password,
    "REGISTRATION_SHARED_SECRET": secrets.token_hex(32),
    "MACAROON_SECRET_KEY": secrets.token_hex(32),
    "FORM_SECRET": secrets.token_hex(32),
    "TURN_SECRET": turn_secret,
}), 0o600)
write_once(synapse_dir / "log.config", lambda: (TEMPLATES / "log.config").read_text())
write_once(synapse_dir / "signing.key", make_signing_key, 0o600)
(synapse_dir / "media_store").mkdir(exist_ok=True)
chown_tree(synapse_dir, SYNAPSE_UID)

# Push gateway: the private key stays with Sygnal, the public key goes to the web app
sygnal_dir = DATA / "sygnal"
vapid_pem = write_once(sygnal_dir / "vapid_private.pem", make_vapid_key, 0o644)
(sygnal_dir / "vapid_public.txt").write_text(vapid_public_key(vapid_pem + "\n"))
write_once(sygnal_dir / "sygnal.yaml", lambda: render("sygnal.yaml.tmpl", settings))

# Call relay
write_once(DATA / "coturn/turnserver.conf", lambda: render("turnserver.conf.tmpl", {
    **settings,
    "TURN_SECRET": turn_secret,
    "TURN_EXTERNAL_IP_LINE": f"external-ip={public_ip}" if public_ip else "# external-ip is set from PUBLIC_IP in .env",
}))

# Admin UI and the optional Cinny client
write_once(DATA / "ketesa.json", lambda: render("ketesa.json.tmpl", settings))
write_once(DATA / "cinny.json", lambda: render("cinny.json.tmpl", settings))

print(f"init: ready for https://{settings['APP_DOMAIN']} with homeserver {settings['MATRIX_DOMAIN']}")
