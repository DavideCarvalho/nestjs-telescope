// packages/core/src/http/axios-source.type.spec.ts
//
// Compile-time regression guard: a REAL `AxiosInstance` (the `axios` package's
// own type, pulled in as a devDependency for exactly this test) must be
// assignable to our duck-typed `AxiosInterceptorLike` with zero casts. This
// broke once in the wild: declaring the fulfilled callbacks as
// `(c: Like) => Like` made axios's `use` (which requires its concrete
// `InternalAxiosRequestConfig` back) structurally incompatible, so
// `attach(httpService.axiosRef)` failed to compile in hosts. The generic
// identity signatures (`<C extends Like>(c: C) => C`) are what keep this green.
import type { AxiosInstance } from 'axios';
import { describe, expect, it } from 'vitest';
import type { AxiosInterceptorLike } from './axios-source.js';

/** Compiles only while `Candidate` is assignable to `Target`. */
type MustBeAssignable<Target, Candidate extends Target> = Candidate;

// The assertion IS the type instantiation — no runtime value, no casts.
type RealAxiosInstanceMatchesTheDuckType = MustBeAssignable<AxiosInterceptorLike, AxiosInstance>;

describe('AxiosInterceptorLike', () => {
  it('accepts a real AxiosInstance structurally (compile-time check)', () => {
    // The type alias above is the actual test; this runtime body only keeps
    // vitest from reporting an empty suite.
    const witness: RealAxiosInstanceMatchesTheDuckType | null = null;
    expect(witness).toBeNull();
  });
});
