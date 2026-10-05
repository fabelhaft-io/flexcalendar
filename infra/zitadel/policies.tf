# Instance policies include first-instance's organization and its users. No
# org override, external IdP, custom action or branding code is created.
resource "zitadel_default_password_complexity_policy" "password" {
  min_length    = 12
  has_uppercase = false
  has_lowercase = false
  has_number    = false
  has_symbol    = false
}
resource "zitadel_default_password_age_policy" "password" {
  max_age_days     = 0
  expire_warn_days = 0
}
resource "zitadel_default_lockout_policy" "login" {
  max_password_attempts = 10 # Administrator unlocks; there is no timed unlock.
  max_otp_attempts      = 0
}
resource "zitadel_default_login_policy" "login" {
  user_login                    = true
  allow_register                = false
  allow_external_idp            = false
  force_mfa                     = false
  force_mfa_local_only          = false
  hide_password_reset           = true
  ignore_unknown_usernames      = false
  allow_domain_discovery        = true
  disable_login_with_email      = false
  disable_login_with_phone      = false
  passwordless_type             = "PASSWORDLESS_TYPE_ALLOWED"
  default_redirect_uri          = ""
  password_check_lifetime       = "240h0m0s"
  external_login_check_lifetime = "240h0m0s"
  mfa_init_skip_lifetime        = "720h0m0s"
  second_factor_check_lifetime  = "18h0m0s"
  multi_factor_check_lifetime   = "12h0m0s"
  second_factors                = ["SECOND_FACTOR_TYPE_OTP", "SECOND_FACTOR_TYPE_U2F"]
  multi_factors                 = ["MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION"]
  idps                          = []
}
resource "zitadel_default_oidc_settings" "tokens" {
  access_token_lifetime         = "12h0m0s"
  id_token_lifetime             = "12h0m0s"
  refresh_token_idle_expiration = "720h0m0s"
  refresh_token_expiration      = "2160h0m0s"
}
