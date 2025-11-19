export type NodeMetrics = {
	firstConnectLatencies: Map<string, number>; // per-peer first connect ms
	pingLatencies: number[]; // ms
};

export type NodeMetricsSnapshot = {
	nodeId: string;
	address: string;
	uniquePeers: number;
	firstConnectCount: number;
	firstConnectAvgMs: number;
	pingCount: number;
	pingAvgMs: number;
};
