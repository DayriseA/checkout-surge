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
import { AutoReviewPage } from "./pages/auto-review";
import { ModelPage } from "./pages/model";
import { ComparisonsPage } from "./pages/comparisons";
import { AgenticTestingPage } from "./pages/agentic-testing";
import { IndependentReviewPage } from "./pages/independent-review";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <OverviewPage /> },
      { path: "/auto-review", element: <AutoReviewPage /> },
      { path: "/models/:modelId", element: <ModelPage /> },
      { path: "/comparisons", element: <ComparisonsPage /> },
      { path: "/agentic-testing", element: <AgenticTestingPage /> },
      { path: "/independent-review", element: <IndependentReviewPage /> },
      { path: "*", element: <OverviewPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
