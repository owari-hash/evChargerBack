/**
 * Comprehensive Unit Tests for Power Monitoring & Calculations
 * Covering all 10 Testing Scenarios from Section 16 of the Requirement Spec.
 */

import {
  calculateStationUtilization,
  calculatePowerSharing,
  calculateElectricalEfficiency,
  diagnosePilePerformance,
} from '../src/services/powerMonitoring.service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Test assertion failed: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

async function runTests() {
  console.log('⚡ Starting EV Charging Power Monitoring Test Suite...\n');

  // =========================================================================
  // Test 1: One pile charging
  // Station capacity: 120 kW. Pile 1 output: 60 kW.
  // Expected: Total output: 60 kW, Available: 60 kW, Utilization: 50%.
  // =========================================================================
  console.log('--- Test 1: One pile charging ---');
  {
    const util = calculateStationUtilization(60, 120);
    assert(util.actualOutputKw === 60, 'Total output must be 60 kW');
    assert(util.availableCapacityKw === 60, 'Available capacity must be 60 kW');
    assert(util.utilizationPct === 50, 'Utilization must be 50%');
    assert(util.overloadKw === 0, 'Overload must be 0 kW');
    assert(!util.isOverloaded, 'Must not be overloaded');
    assert(util.statusLevel === 'NORMAL', 'Status level must be NORMAL');
  }

  // =========================================================================
  // Test 2: Two piles charging equally
  // Station capacity: 120 kW. Pile 1: 60 kW, Pile 2: 60 kW.
  // Expected: Total output: 120 kW, Available: 0 kW, Utilization: 100%.
  // =========================================================================
  console.log('\n--- Test 2: Two piles charging equally ---');
  {
    const piles = [
      { connectorId: 1, activePowerKw: 60, ratedPowerKw: 60, status: 'Charging' },
      { connectorId: 2, activePowerKw: 60, ratedPowerKw: 60, status: 'Charging' },
    ];
    const totalOutput = piles.reduce((s, p) => s + p.activePowerKw, 0);
    const util = calculateStationUtilization(totalOutput, 120);
    const sharing = calculatePowerSharing(120, piles);

    assert(util.actualOutputKw === 120, 'Total output must be 120 kW');
    assert(util.availableCapacityKw === 0, 'Available capacity must be 0 kW');
    assert(util.utilizationPct === 100, 'Utilization must be 100%');
    assert(sharing.status === 'EQUAL_SHARING', 'Power sharing status must be EQUAL_SHARING');
    assert(sharing.isCapacityReached, 'Station has reached its configured power limit');
  }

  // =========================================================================
  // Test 3: Unequal power distribution
  // Station capacity: 120 kW. Pile 1: 80 kW, Pile 2: 40 kW.
  // Expected: Total output: 120 kW, Utilization: 100%, dynamic distribution.
  // =========================================================================
  console.log('\n--- Test 3: Unequal power distribution ---');
  {
    const piles = [
      { connectorId: 1, activePowerKw: 80, ratedPowerKw: 100, status: 'Charging' },
      { connectorId: 2, activePowerKw: 40, ratedPowerKw: 60, status: 'Charging' },
    ];
    const totalOutput = piles.reduce((s, p) => s + p.activePowerKw, 0);
    const util = calculateStationUtilization(totalOutput, 120);
    const sharing = calculatePowerSharing(120, piles);

    assert(util.actualOutputKw === 120, 'Total output must be 120 kW');
    assert(util.utilizationPct === 100, 'Utilization must be 100%');
    assert(sharing.status === 'DYNAMIC_SHARING', 'Power sharing status must be DYNAMIC_SHARING');
    assert(sharing.allocations[0].sharePct === 66.7, 'Pile 1 share must be 66.7%');
    assert(sharing.allocations[1].sharePct === 33.3, 'Pile 2 share must be 33.3%');
  }

  // =========================================================================
  // Test 4: Power limit exceeded (Overload)
  // Station capacity: 120 kW. Pile 1: 80 kW, Pile 2: 50 kW.
  // Expected: Total: 130 kW, Available: 0 kW (never negative!), Overload: 10 kW.
  // =========================================================================
  console.log('\n--- Test 4: Power limit exceeded (Overload) ---');
  {
    const util = calculateStationUtilization(130, 120);
    assert(util.actualOutputKw === 130, 'Total output must be 130 kW');
    assert(util.availableCapacityKw === 0, 'Available capacity must NEVER be negative (must be 0)');
    assert(util.overloadKw === 10, 'Overload must be 10 kW');
    assert(util.isOverloaded === true, 'isOverloaded must be true');
    assert(util.statusLevel === 'OVERLOAD', 'Status level must be OVERLOAD warning');
  }

  // =========================================================================
  // Test 5: Charger underperformance
  // Pile rated capacity: 120 kW. Measured output: 45 kW.
  // Expected vehicle demand: 100 kW.
  // Expected: Performance: Below expected / UNDERPERFORMING.
  // =========================================================================
  console.log('\n--- Test 5: Charger underperformance ---');
  {
    const diag = diagnosePilePerformance({
      ratedPowerKw: 120,
      activePowerKw: 45,
      chargingStatus: 'Charging',
      socPercent: 35, // Low SoC (<70%) where battery should accept high charge
      vehicleMaxPowerKw: 100,
      stationThrottled: false,
    });

    assert(diag.status === 'UNDERPERFORMING', 'Diagnosis must be UNDERPERFORMING');
    assert(diag.actualPowerKw === 45, 'Actual power is 45 kW');
    assert(diag.expectedPowerKw === 100, 'Expected power is 100 kW');
    assert(diag.explanation.includes('Хүлээгдэж буй чадал'), 'Explanation must provide operational guidance');

    // Also verify that when vehicle SoC is 90% (tapering), it is correctly identified as LIMITED_BY_VEHICLE, not charger fault!
    const diagTaper = diagnosePilePerformance({
      ratedPowerKw: 120,
      activePowerKw: 25,
      chargingStatus: 'Charging',
      socPercent: 92,
      vehicleMaxPowerKw: 100,
    });
    assert(diagTaper.status === 'LIMITED_BY_VEHICLE', 'High SoC tapering must be diagnosed as LIMITED_BY_VEHICLE, not fault');
  }

  // =========================================================================
  // Test 6: Electrical power difference
  // Station incoming power: 125 kW. Pile 1: 55 kW, Pile 2: 55 kW.
  // Expected: Total output: 110 kW, Input/output diff: 15 kW, Efficiency: 88%.
  // =========================================================================
  console.log('\n--- Test 6: Electrical power difference ---');
  {
    const eff = calculateElectricalEfficiency(125, 110);
    assert(eff.inputMeterAvailable === true, 'Input meter must be reported available');
    assert(eff.incomingPowerKw === 125, 'Incoming power is 125 kW');
    assert(eff.totalOutputKw === 110, 'Total output is 110 kW');
    assert(eff.powerDifferenceKw === 15, 'Power difference is 15 kW');
    assert(eff.outputEfficiencyPct === 88, 'Efficiency must be 88%');
    assert(eff.notice === null, 'Notice must be null when meter is available');
  }

  // =========================================================================
  // Test 7: No upstream meter
  // Station input power: unavailable (null/undefined).
  // Pile 1: 50 kW, Pile 2: 50 kW.
  // Expected: Total output: 100 kW, loss percentage unavailable, clear notice.
  // =========================================================================
  console.log('\n--- Test 7: No upstream meter ---');
  {
    const eff = calculateElectricalEfficiency(null, 100);
    assert(eff.inputMeterAvailable === false, 'inputMeterAvailable must be false');
    assert(eff.incomingPowerKw === null, 'incomingPowerKw must be null');
    assert(eff.powerDifferenceKw === null, 'powerDifferenceKw must NOT be fabricated');
    assert(eff.outputEfficiencyPct === null, 'outputEfficiencyPct must NOT be fabricated');
    assert(eff.notice === 'Station input meter not available.', 'Must display required meter not available notice');
  }

  // =========================================================================
  // Test 8: Missing telemetry
  // Pile charging but zero power / missing measurements.
  // =========================================================================
  console.log('\n--- Test 8: Missing telemetry ---');
  {
    const diag = diagnosePilePerformance({
      ratedPowerKw: 60,
      activePowerKw: 0,
      chargingStatus: 'Charging',
    });
    assert(diag.status === 'INSUFFICIENT_TELEMETRY', 'Zero power while charging must be flagged as INSUFFICIENT_TELEMETRY');
  }

  // =========================================================================
  // Test 9: Multiple stations network aggregation
  // Three stations with different capacities and active charging sessions.
  // =========================================================================
  console.log('\n--- Test 9: Multiple stations network aggregation ---');
  {
    const stationA = calculateStationUtilization(90, 120);
    const stationB = calculateStationUtilization(120, 180);
    const stationC = calculateStationUtilization(0, 60);

    const totalCapacity = 120 + 180 + 60;
    const totalOutput = 90 + 120 + 0;
    const networkUtil = calculateStationUtilization(totalOutput, totalCapacity);

    assert(networkUtil.actualOutputKw === 210, 'Network output must be 210 kW');
    assert(networkUtil.configuredCapacityKw === 360, 'Network capacity must be 360 kW');
    assert(networkUtil.availableCapacityKw === 150, 'Network available must be 150 kW');
    assert(networkUtil.utilizationPct === 58.3, 'Network utilization must be 58.3%');
  }

  // =========================================================================
  // Test 10: Session completion
  // Vehicle stops charging, returns to idle, preserves energy.
  // =========================================================================
  console.log('\n--- Test 10: Session completion ---');
  {
    const diagAfterStop = diagnosePilePerformance({
      ratedPowerKw: 60,
      activePowerKw: 0,
      chargingStatus: 'Available',
    });
    assert(diagAfterStop.status === 'IDLE', 'Post-session connector must return to IDLE');
    assert(diagAfterStop.actualPowerKw === 0, 'Active power must be 0 kW');
  }

  console.log('\n🎉 ALL 10 TEST SCENARIOS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
