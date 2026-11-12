extern int sandbox_check(int pid, const char *operation, int filter, ...);

/* Darwin arm64 passes variadic arguments on the stack, unlike fixed-arity FFI arguments. */
int paddock_sandbox_check(int pid, const char *operation, int filter, const char *argument) {
    return sandbox_check(pid, operation, filter, argument);
}
