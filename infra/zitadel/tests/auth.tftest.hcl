mock_provider "zitadel" {}
variables {
  org_id       = "bootstrap-org"
  domain       = "auth.staging.flexcalendar.de"
  access_token = "test-only"
}
run "local" {
  command = plan
  variables { environment = "local" }
  assert {
    condition     = length(zitadel_machine_user.token_helper) == 1 && length(zitadel_instance_member.token_helper) == 1 && length(zitadel_personal_access_token.token_helper) == 1
    error_message = "Local must have its own helper account, role and PAT."
  }
}
run "staging" {
  command = plan
  variables { environment = "staging" }
  assert {
    condition     = length(zitadel_machine_user.token_helper) == 1
    error_message = "Staging must have its own helper account."
  }
}
run "production" {
  command = plan
  variables { environment = "production" }
  assert {
    condition     = length(zitadel_machine_user.token_helper) == 0 && length(zitadel_instance_member.token_helper) == 0 && length(zitadel_personal_access_token.token_helper) == 0
    error_message = "Production must contain no helper account, role or credential."
  }
  assert {
    condition     = zitadel_application_oidc.android.access_token_type == "OIDC_TOKEN_TYPE_JWT" && zitadel_application_oidc.android.auth_method_type == "OIDC_AUTH_METHOD_TYPE_NONE" && zitadel_application_oidc.android.app_type == "OIDC_APP_TYPE_NATIVE"
    error_message = "Android requires a native, public PKCE client issuing JWTs."
  }
  assert {
    condition     = zitadel_default_password_complexity_policy.password.min_length == 12 && !zitadel_default_password_complexity_policy.password.has_uppercase && !zitadel_default_password_complexity_policy.password.has_lowercase && !zitadel_default_password_complexity_policy.password.has_number && !zitadel_default_password_complexity_policy.password.has_symbol && zitadel_default_password_age_policy.password.max_age_days == 0
    error_message = "Password policy must be 12 characters, no composition or expiry."
  }
  assert {
    condition     = !zitadel_default_login_policy.login.allow_register && !zitadel_default_login_policy.login.allow_external_idp && !zitadel_default_login_policy.login.force_mfa && zitadel_default_login_policy.login.hide_password_reset && zitadel_default_lockout_policy.login.max_password_attempts == 10 && zitadel_default_lockout_policy.login.max_otp_attempts == 0
    error_message = "Login surface must match ADR 0003 and E02-R09."
  }
}
run "exact_auth_surface" {
  command = plan
  variables { environment = "staging" }
  assert {
    condition     = length(zitadel_application_oidc.android.grant_types) == 2 && contains(zitadel_application_oidc.android.grant_types, "OIDC_GRANT_TYPE_AUTHORIZATION_CODE") && contains(zitadel_application_oidc.android.grant_types, "OIDC_GRANT_TYPE_REFRESH_TOKEN") && zitadel_application_oidc.android.redirect_uris[0] == "de.flexcalendar.app:/oauth2redirect" && zitadel_application_oidc.android.post_logout_redirect_uris[0] == "de.flexcalendar.app:/logout" && zitadel_application_oidc.android.android[0].package_name == "de.flexcalendar.app" && !zitadel_application_oidc.android.dev_mode
    error_message = "Android grants, package, RFC 8252 redirects and compliance mode must not drift."
  }
  assert {
    condition     = zitadel_default_oidc_settings.tokens.access_token_lifetime == "12h0m0s" && zitadel_default_oidc_settings.tokens.id_token_lifetime == "12h0m0s" && zitadel_default_oidc_settings.tokens.refresh_token_idle_expiration == "720h0m0s" && zitadel_default_oidc_settings.tokens.refresh_token_expiration == "2160h0m0s" && zitadel_default_login_policy.login.password_check_lifetime == "240h0m0s" && zitadel_default_login_policy.login.external_login_check_lifetime == "240h0m0s" && zitadel_default_login_policy.login.second_factor_check_lifetime == "18h0m0s" && zitadel_default_login_policy.login.multi_factor_check_lifetime == "12h0m0s" && zitadel_default_login_policy.login.mfa_init_skip_lifetime == "720h0m0s"
    error_message = "All token and login lifetimes must match the pinned v4.16 defaults."
  }
  assert {
    condition     = length(zitadel_instance_member.token_helper[0].roles) == 1 && contains(zitadel_instance_member.token_helper[0].roles, "IAM_LOGIN_CLIENT") && !zitadel_machine_user.token_helper[0].with_secret && zitadel_machine_user.token_helper[0].user_name != "login-client" && length(zitadel_default_login_policy.login.idps) == 0 && zitadel_default_login_policy.login.passwordless_type == "PASSWORDLESS_TYPE_ALLOWED" && contains(zitadel_default_login_policy.login.second_factors, "SECOND_FACTOR_TYPE_OTP") && contains(zitadel_default_login_policy.login.second_factors, "SECOND_FACTOR_TYPE_U2F") && contains(zitadel_default_login_policy.login.multi_factors, "MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION")
    error_message = "Factors and helper privilege/identity must not drift."
  }
}
