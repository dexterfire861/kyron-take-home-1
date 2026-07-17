"""Load app secrets: from .env locally, from SSM Parameter Store in production.

Setting AWS_SSM_PREFIX (e.g. "/kyron/prod") switches to Parameter Store —
values there override anything in the environment/.env.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

PARAMETER_NAMES = ["DATABASE_URL", "JWT_SECRET", "OPENAI_API_KEY"]


def load_secrets() -> None:
    load_dotenv()

    prefix = os.getenv("AWS_SSM_PREFIX")
    if not prefix:
        return

    import boto3

    client = boto3.client("ssm", region_name=os.getenv("AWS_REGION", "us-east-1"))
    full_names = [f"{prefix}/{name}" for name in PARAMETER_NAMES]
    response = client.get_parameters(Names=full_names, WithDecryption=True)
    for param in response["Parameters"]:
        name = param["Name"].rsplit("/", 1)[-1]
        os.environ[name] = param["Value"]
