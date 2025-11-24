export type Input =
	| string
	| number
	| bigint
	| Uint8Array
	| Array<Input>
	| null
	| undefined;

export type NestedUint8Array = Array<Uint8Array | NestedUint8Array>;

export interface Decoded {
	data: Uint8Array | NestedUint8Array;
	remainder: Uint8Array;
}
