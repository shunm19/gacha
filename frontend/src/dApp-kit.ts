import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { LOCAL } from "./config";

const GRPC_URLS = {
  testnet: "https://fullnode.testnet.sui.io:443",
  localnet: "http://127.0.0.1:9000",
};

// VITE_ORIPA_NETWORK=local points the app at `sui start` for development.
export const dAppKit = createDAppKit({
  enableBurnerWallet: import.meta.env.DEV,
  networks: LOCAL ? ["localnet"] : ["testnet"],
  defaultNetwork: LOCAL ? "localnet" : "testnet",
  createClient(network) {
    return new SuiGrpcClient({ network, baseUrl: GRPC_URLS[network] });
  },
});

// global type registration necessary for the hooks to work correctly
declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
