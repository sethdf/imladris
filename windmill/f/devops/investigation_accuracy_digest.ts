// Windmill Script: Investigation Accuracy Digest
// Weekly report analyzing investigation feedback ratings by domain.
// Identifies worst-performing alert types and common misdiagnosis patterns.
// Scheduled: Monday 8am via Windmill schedule.

import * as cacheLib from "./cache_lib.ts";

export async function main(
  days_back: number = 7,
  include_all_time: boolean = true,
): Promise<{
  period: string;
  period_stats: ReturnType<typeof cacheLib.getFeedbackStats>;
  all_time_stats?: ReturnType<typeof cacheLib.getFeedbackStats>;
  insights: string[];
  recommendations: string[];
}> {
  cacheLib.init();

  const periodStats = cacheLib.getFeedbackStats(days_back);
  const allTimeStats = include_all_time ? cacheLib.getFeedbackStats(365) : undefined;

  // Generate insights from the data
  const insights: string[] = [];
  const recommendations: string[] = [];

  if (periodStats.total_ratings === 0) {
    insights.push(`No feedback ratings recorded in the last ${days_back} days.`);
    recommendations.push("Start rating investigation results to build accuracy data.");
    return {
      period: `Last ${days_back} days`,
      period_stats: periodStats,
      all_time_stats: allTimeStats,
      insights,
      recommendations,
    };
  }

  // Overall accuracy
  insights.push(`${periodStats.total_ratings} investigations rated in the last ${days_back} days, average rating: ${periodStats.average_rating}/5`);

  if (periodStats.average_rating < 3) {
    insights.push("WARNING: Average rating below 3.0 — investigation quality needs attention.");
  } else if (periodStats.average_rating >= 4.5) {
    insights.push("Investigation accuracy is excellent (4.5+/5).");
  }

  // Domain breakdown
  for (const [domain, stats] of Object.entries(periodStats.by_domain)) {
    if (stats.avg_rating < 3) {
      insights.push(`Domain '${domain}' performing poorly: ${stats.avg_rating}/5 across ${stats.count} ratings.`);
      const topMisType = Object.entries(stats.misdiagnosis_types)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `${type} (${count}x)`);
      if (topMisType.length > 0) {
        insights.push(`  Common misdiagnosis types in ${domain}: ${topMisType.join(", ")}`);
      }
    }
  }

  // Worst alert types
  if (periodStats.worst_alert_types.length > 0) {
    for (const worst of periodStats.worst_alert_types.slice(0, 3)) {
      if (worst.avg_rating < 3) {
        recommendations.push(
          `Alert type '${worst.alert_type}' has ${worst.avg_rating}/5 avg across ${worst.count} ratings — consider adding targeted knowledge runbook or additional tools.`
        );
      }
    }
  }

  // Misdiagnosis patterns
  const topMisTypes = Object.entries(periodStats.by_misdiagnosis_type)
    .sort((a, b) => b[1] - a[1]);
  if (topMisTypes.length > 0) {
    const [topType, topCount] = topMisTypes[0];
    if (topType !== "correct") {
      recommendations.push(
        `Most common error: '${topType}' (${topCount}x) — review evidence chain requirements for this failure mode.`
      );
    }
  }

  // Trend comparison (if all-time data available)
  if (allTimeStats && allTimeStats.total_ratings > periodStats.total_ratings) {
    const diff = periodStats.average_rating - allTimeStats.average_rating;
    if (Math.abs(diff) > 0.3) {
      insights.push(
        `Trend: ${diff > 0 ? "improving" : "declining"} (${diff > 0 ? "+" : ""}${diff.toFixed(2)} vs all-time average of ${allTimeStats.average_rating}).`
      );
    }
  }

  // Low-rated investigations needing review
  if (periodStats.recent_low_ratings.length > 0) {
    insights.push(`${periodStats.recent_low_ratings.length} investigations rated 1-2/5 need review.`);
  }

  return {
    period: `Last ${days_back} days`,
    period_stats: periodStats,
    all_time_stats: allTimeStats,
    insights,
    recommendations,
  };
}
