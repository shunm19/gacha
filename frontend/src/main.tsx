import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.tsx";
import { dAppKit } from "./dApp-kit.ts";

// Keep polling chain state even when the tab is not focused (demo screens).
const queryClient = new QueryClient({ defaultOptions: { queries: { refetchIntervalInBackground: true } } });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <DAppKitProvider dAppKit={dAppKit}>
        <App />
      </DAppKitProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
