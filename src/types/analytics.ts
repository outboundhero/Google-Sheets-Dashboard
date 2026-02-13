export interface DashboardAnalytics {
  totalLeads: number;
  qualityLeads: number;
  notQualityLeads: number;
  undeterminedLeads: number;
  leadNotReceived: number;
  duplicated: number;
  qualityLeadPercentage: number;
  meetingReadyLeads: number;
  interestedLeads: number;
  meetingReadyLast24h: number;
  meetingReadyWithoutStatus: number;
  meetingReadyWithoutStatusTotal: number;
  clientsWithoutRecentMeetingReady: string[];
  leadsByClient: { client: string; count: number }[];
  leadsByStatus: { status: string; count: number }[];
  leadsByCategory: { category: string; count: number }[];
  leadsOverTime: { date: string; count: number }[];
  topClients: {
    client: string;
    qualityLeads: number;
    totalLeads: number;
    percentage: number;
  }[];
}
