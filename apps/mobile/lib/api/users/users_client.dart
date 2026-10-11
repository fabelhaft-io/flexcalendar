// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/user.dart';

part 'users_client.g.dart';

@RestApi()
abstract class UsersClient {
  factory UsersClient(Dio dio, {String? baseUrl}) = _UsersClient;

  /// The authenticated user.
  ///
  /// The `users` row the access token's `sub` maps to. Created on first sight from the issuer's userinfo (`handle` from `preferred_username`, `email` from `email`, both after `email_verified`); a subject already in `users` is read back without another userinfo call.
  @GET('/me')
  Future<User> getMe();
}
