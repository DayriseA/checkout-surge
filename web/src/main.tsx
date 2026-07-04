import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";

import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";

import { Layout } from "./components/layout";
import { OverviewPage } from "./pages/overview";
import { FindingsPage } from "./pages/findings";
import { ClustersPage } from "./pages/clusters";
import { ModelPage } from "./pages/model";
import { ComparisonsPage } from "./pages/comparisons";
import { ManualFindingsPage } from "./pages/manual-findings";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <OverviewPage /> },
      { path: "/findings", element: <FindingsPage /> },
      { path: "/clusters", element: <ClustersPage /> },
      { path: "/models/:modelId", element: <ModelPage /> },
      { path: "/comparisons", element: <ComparisonsPage /> },
      { path: "/manual-findings", element: <ManualFindingsPage /> },
      { path: "*", element: <OverviewPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
