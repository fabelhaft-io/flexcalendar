# The organization and bootstrap accounts are owned by first-instance settings,
# not duplicated here. The same resources are applied in every environment.
resource "zitadel_project" "calendar" {
  org_id                   = var.org_id
  name                     = "calendar-flex"
  project_role_assertion   = false
  project_role_check       = false
  has_project_check        = false
  private_labeling_setting = "PRIVATE_LABELING_SETTING_ENFORCE_PROJECT_RESOURCE_OWNER_POLICY"
}
resource "zitadel_application_api" "api" {
  org_id           = var.org_id
  project_id       = zitadel_project.calendar.id
  name             = "calendar-flex API"
  auth_method_type = "API_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT"
  # No application key or client secret: the API only validates user JWTs.
}
resource "zitadel_application_oidc" "android" {
  org_id                       = var.org_id
  project_id                   = zitadel_project.calendar.id
  name                         = "de.flexcalendar.app"
  redirect_uris                = ["de.flexcalendar.app:/oauth2redirect"]
  post_logout_redirect_uris    = ["de.flexcalendar.app:/logout"]
  response_types               = ["OIDC_RESPONSE_TYPE_CODE"]
  grant_types                  = ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"]
  app_type                     = "OIDC_APP_TYPE_NATIVE"
  auth_method_type             = "OIDC_AUTH_METHOD_TYPE_NONE" # Public client, PKCE required by Zitadel.
  version                      = "OIDC_VERSION_1_0"
  clock_skew                   = "0s"
  dev_mode                     = false
  access_token_type            = "OIDC_TOKEN_TYPE_JWT"
  access_token_role_assertion  = false
  id_token_role_assertion      = false
  id_token_userinfo_assertion  = false
  additional_origins           = []
  skip_native_app_success_page = true
  android {
    package_name             = "de.flexcalendar.app"
    sha256_cert_fingerprints = [] # No signing certificates/keys stored here.
  }
}
# This is a DIFFERENT account from first-instance's login-client. It has the
# custom-login APIs' required role, never IAM_OWNER; absent in production.
resource "zitadel_machine_user" "token_helper" {
  count             = var.environment == "production" ? 0 : 1
  org_id            = var.org_id
  name              = "calendar-flex test token helper"
  user_name         = "calflex-token-helper"
  description       = "Browserless test login; local and staging only"
  access_token_type = "ACCESS_TOKEN_TYPE_JWT"
  with_secret       = false
}
resource "zitadel_instance_member" "token_helper" {
  count   = var.environment == "production" ? 0 : 1
  user_id = zitadel_machine_user.token_helper[0].id
  roles   = ["IAM_LOGIN_CLIENT"]
}
resource "zitadel_personal_access_token" "token_helper" {
  count           = var.environment == "production" ? 0 : 1
  org_id          = var.org_id
  user_id         = zitadel_machine_user.token_helper[0].id
  expiration_date = "2030-01-01T00:00:00Z"
  depends_on      = [zitadel_instance_member.token_helper]
}
