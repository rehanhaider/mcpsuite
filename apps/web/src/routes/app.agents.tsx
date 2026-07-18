import { createFileRoute } from "@tanstack/react-router";
import { AgentsPage } from "~/components/AgentsPage.tsx";

export const Route = createFileRoute("/app/agents")({ component: AgentsPage });
