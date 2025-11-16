import type { PeerId } from "../../../session/nodeInfo.js";
import type { RendezvousMessageHandler } from "./broadcast-advert.js";

export class DiscoverRequestHandler implements RendezvousMessageHandler {
	public handle = async (peerId: PeerId, frame: any) => {
		return frame;
	};
}
