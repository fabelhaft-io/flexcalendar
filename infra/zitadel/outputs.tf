output "project_id" {
  value = zitadel_project.calendar.id
}
output "android_client_id" {
  value     = zitadel_application_oidc.android.client_id
  sensitive = true
}
output "token_helper_pat" {
  value     = var.environment == "production" ? null : zitadel_personal_access_token.token_helper[0].token
  sensitive = true
}
