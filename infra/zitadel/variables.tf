variable "environment" {
  type = string
  validation {
    condition     = contains(["local", "staging", "production"], var.environment)
    error_message = "Choose local, staging or production."
  }
}
variable "domain" {
  type = string
}
variable "port" {
  type    = string
  default = "443"
}
variable "org_id" {
  type = string
}
variable "access_token" {
  type      = string
  sensitive = true
}
# Local uses the private container network; staging/production always use TLS.
variable "insecure" {
  type    = bool
  default = false
  validation {
    condition     = !var.insecure || var.environment == "local"
    error_message = "Plain HTTP is only permitted on the local container network."
  }
}
variable "authority" {
  type    = string
  default = ""
}
provider "zitadel" {
  domain            = var.domain
  port              = var.port
  insecure          = var.insecure
  access_token      = var.access_token
  transport_headers = var.authority == "" ? {} : { "Host" = var.authority, "x-zitadel-forward-host" = var.authority }
}
