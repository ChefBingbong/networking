export const asciis = {
	_0: 48,
	_9: 57,
	_A: 65,
	_F: 70,
	_a: 97,
	_f: 102,
} as const;

export const cachedHexes = Array.from({ length: 256 }, (_v, i) =>
	i.toString(16).padStart(2, "0"),
);
