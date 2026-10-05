terraform {
  required_version = "= 1.13.1"
  required_providers {
    zitadel = {
      source  = "zitadel/zitadel"
      version = "= 3.8.7"
    }
  }
  # State belongs to the same database/backup lifecycle as the Zitadel instance.
  # PG_CONN_STR comes from the environment, never backend CLI arguments.
  backend "pg" {
    schema_name = "calflex_tofu"
  }
}
