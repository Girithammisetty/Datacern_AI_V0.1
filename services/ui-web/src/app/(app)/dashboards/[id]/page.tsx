"use client";
import { use } from "react";
import { DashboardViewer } from "@/components/dashboards/DashboardViewer";

export default function DashboardDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <DashboardViewer id={id} />;
}
