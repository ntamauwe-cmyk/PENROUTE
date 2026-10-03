/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as adapters from "../adapters.js";
import type * as admin from "../admin.js";
import type * as auth from "../auth.js";
import type * as auth_emailOtp from "../auth/emailOtp.js";
import type * as contributions from "../contributions.js";
import type * as employers from "../employers.js";
import type * as engine from "../engine.js";
import type * as githubSync from "../githubSync.js";
import type * as githubSyncData from "../githubSyncData.js";
import type * as http from "../http.js";
import type * as payments from "../payments.js";
import type * as payrollApi from "../payrollApi.js";
import type * as paystackWebhook from "../paystackWebhook.js";
import type * as pension from "../pension.js";
import type * as pfaDirectory from "../pfaDirectory.js";
import type * as pfaDispatch from "../pfaDispatch.js";
import type * as pfaDispatchData from "../pfaDispatchData.js";
import type * as pfaPortal from "../pfaPortal.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  adapters: typeof adapters;
  admin: typeof admin;
  auth: typeof auth;
  "auth/emailOtp": typeof auth_emailOtp;
  contributions: typeof contributions;
  employers: typeof employers;
  engine: typeof engine;
  githubSync: typeof githubSync;
  githubSyncData: typeof githubSyncData;
  http: typeof http;
  payments: typeof payments;
  payrollApi: typeof payrollApi;
  paystackWebhook: typeof paystackWebhook;
  pension: typeof pension;
  pfaDirectory: typeof pfaDirectory;
  pfaDispatch: typeof pfaDispatch;
  pfaDispatchData: typeof pfaDispatchData;
  pfaPortal: typeof pfaPortal;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
