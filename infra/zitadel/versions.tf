terraform {
  required_version = "= 1.13.1"
  required_providers {
    zitadel = {
      source  = "zitadel/zitadel"
      version = "= 3.8.7"
    }
  }
  backend "local" {}
}
