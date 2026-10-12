/// A piece of local state that must go when the user signs out (E10-R02).
typedef SignOutHook = Future<void> Function();

/// The sign-out hook list later requirements register into.
///
/// E10-R02 owns the list and the guarantee that every hook runs on sign-out;
/// the hooks themselves arrive later: the offline cache (E10-R03), the device
/// keys (E12-R06) and, in Phase 4, the push token (E07-R03).
class SignOutHooks {
  final List<SignOutHook> _hooks = <SignOutHook>[];

  /// Registers [hook]. Registration order is execution order.
  void register(SignOutHook hook) => _hooks.add(hook);

  /// Runs every registered hook, even if an earlier one throws, so one broken
  /// cleanup step cannot leave the others' state behind. The first error is
  /// rethrown once all hooks have run.
  Future<void> runAll() async {
    Object? firstError;
    StackTrace? firstStackTrace;
    for (final hook in List<SignOutHook>.of(_hooks)) {
      try {
        await hook();
      } catch (error, stackTrace) {
        if (firstError == null) {
          firstError = error;
          firstStackTrace = stackTrace;
        }
      }
    }
    if (firstError != null) {
      Error.throwWithStackTrace(firstError, firstStackTrace!);
    }
  }
}
