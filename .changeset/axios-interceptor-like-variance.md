---
"@dudousxd/nestjs-telescope": patch
---

Fix `AxiosInterceptorLike` so a real `AxiosInstance` (including `@nestjs/axios`'s `HttpService.axiosRef`) is assignable without casts. The fulfilled interceptor callbacks are now generic identity signatures (`<C extends AxiosRequestConfigLike>(config: C) => C`) instead of returning the structural type, which axios's own `use` rejected (it requires its concrete `InternalAxiosRequestConfig` back). A compile-time regression test against the real axios types guards this.
