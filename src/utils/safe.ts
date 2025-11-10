import * as _ from "radash";

export type SafePromise<T, E extends Error | string = Error> = Promise<
	SafeError<E> | SafeResult<T>
>;

export type Safe<T, E extends Error | string = Error> =
	| SafeError<E>
	| SafeResult<T>;

export type SafeResult<T> = [undefined, T];
export type SafeError<E extends Error | string> = [E, undefined];

export function safeResult<T>(res: T): SafeResult<T> {
	return [undefined, res];
}

export function safeErrorStr<T extends string>(err: T): SafeError<T> {
	return [err, undefined] as const;
}

export function safeError<E extends Error>(err: E): SafeError<E> {
	return [err, undefined];
}

export async function safeTry<T>(promise: () => Promise<T>): SafePromise<T> {
	return _.try(promise)();
}

export function safeSyncTry<T>(callBack: () => T) {
	return _.try(callBack)();
}
