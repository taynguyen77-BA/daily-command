"use client";

import { useEffect } from "react";
import { MeetingModePanel, trackMeetingModeOpened } from "@/components/command-center/MeetingModePanel";

export default function MeetingModePage() {
  useEffect(() => {
    trackMeetingModeOpened();
  }, []);
  return <MeetingModePanel />;
}
