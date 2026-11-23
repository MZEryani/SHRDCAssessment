SETUP
VAR
    cell : ConveyorCellController;
END_VAR
    cell(
        Start_PB := FALSE,
        Stop_PB := FALSE,
        EStop := FALSE,
        Reset_Count_PB := FALSE,
        PhotoEye := FALSE
    );
END_SETUP

TEST 'Start latches running and Stop halts cleanly'
    ASSERT_FALSE(cell.Conveyor_Run);
    ASSERT_FALSE(cell.Run_Light);

    (* Momentary Start press latches Cell *)
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_TRUE(cell.Conveyor_Run);
    ASSERT_TRUE(cell.Run_Light);
    ASSERT_FALSE(cell.Fault_Light);

    (* Releasing Start keeps Cell running *)
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_TRUE(cell.Conveyor_Run);
    ASSERT_TRUE(cell.Run_Light);

    (* Stop drops Conveyor_Run, Spawner_Enable, and Run_Light *)
    cell(Start_PB := FALSE, Stop_PB := TRUE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_FALSE(cell.Conveyor_Run);
    ASSERT_FALSE(cell.Spawner_Enable);
    ASSERT_FALSE(cell.Run_Light);
END_TEST

TEST 'EStop halts immediately, lights Fault_Light, and blocks restart until released'
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_TRUE(cell.Conveyor_Run);

    (* Engage E-Stop *)
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := TRUE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_FALSE(cell.Conveyor_Run);
    ASSERT_FALSE(cell.Spawner_Enable);
    ASSERT_FALSE(cell.Run_Light);
    ASSERT_TRUE(cell.Fault_Light);

    (* Start is rejected while E-Stop is active *)
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := TRUE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_FALSE(cell.Conveyor_Run);
    ASSERT_TRUE(cell.Fault_Light);

    (* Releasing E-Stop while Start_PB is still held TRUE must NOT auto-restart *)
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_FALSE(cell.Conveyor_Run);
    ASSERT_FALSE(cell.Fault_Light);

    (* Releasing Start_PB then pressing a fresh Start edge resumes *)
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_FALSE(cell.Conveyor_Run);
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_TRUE(cell.Conveyor_Run);
END_TEST

TEST 'PhotoEye rising edge counts once and runs 2s Inspection Dwell'
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);

    (* Box hits Photo-Eye *)
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_EQ(cell.Box_Count, 1);
    ASSERT_FALSE(cell.Conveyor_Run);
    ASSERT_FALSE(cell.Spawner_Enable);
    ASSERT_TRUE(cell.Dwell_Light);
    ASSERT_TRUE(cell.Run_Light);

    (* Still dwelling at 1.9s; continuous TRUE does not double-count *)
    ADVANCE_TIME(1900000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_EQ(cell.Box_Count, 1);
    ASSERT_FALSE(cell.Conveyor_Run);
    ASSERT_FALSE(cell.Spawner_Enable);
    ASSERT_TRUE(cell.Dwell_Light);

    (* At 2.0s dwell completes and conveyor resumes *)
    ADVANCE_TIME(100000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_EQ(cell.Box_Count, 1);
    ASSERT_TRUE(cell.Conveyor_Run);
    ASSERT_FALSE(cell.Dwell_Light);
END_TEST

TEST 'Batch auto-stops at 5 boxes and blocks Start until Reset when stopped'
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);

    (* Box 1 *)
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_EQ(cell.Box_Count, 1);
    ADVANCE_TIME(2000000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_TRUE(cell.Conveyor_Run);
    ADVANCE_TIME(200000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);

    (* Box 2 *)
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_EQ(cell.Box_Count, 2);
    ADVANCE_TIME(2000000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_TRUE(cell.Conveyor_Run);
    ADVANCE_TIME(200000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);

    (* Box 3 *)
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_EQ(cell.Box_Count, 3);
    ADVANCE_TIME(2000000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_TRUE(cell.Conveyor_Run);
    ADVANCE_TIME(200000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);

    (* Box 4 *)
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_EQ(cell.Box_Count, 4);
    ADVANCE_TIME(2000000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_TRUE(cell.Conveyor_Run);
    ADVANCE_TIME(200000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);

    (* Box 5 completes the Batch and stops the Cell *)
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_EQ(cell.Box_Count, 5);
    ASSERT_FALSE(cell.Conveyor_Run);
    ASSERT_FALSE(cell.Spawner_Enable);
    ASSERT_FALSE(cell.Run_Light);
    ASSERT_FALSE(cell.Dwell_Light);

    (* Start is blocked while Batch is full *)
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_FALSE(cell.Conveyor_Run);

    (* Reset clears count when stopped, then Start runs again *)
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := TRUE, PhotoEye := FALSE);
    ASSERT_EQ(cell.Box_Count, 0);
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_TRUE(cell.Conveyor_Run);
END_TEST

TEST 'Reset_Count_PB is ignored while running and honored while stopped'
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_EQ(cell.Box_Count, 1);

    (* Finish dwell so Cell is actively running *)
    ADVANCE_TIME(2000000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_TRUE(cell.Conveyor_Run);

    (* Reset while running must NOT clear Box_Count *)
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := TRUE, PhotoEye := FALSE);
    ASSERT_EQ(cell.Box_Count, 1);

    (* Stop, then Reset clears Box_Count *)
    cell(Start_PB := FALSE, Stop_PB := TRUE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_FALSE(cell.Conveyor_Run);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := TRUE, PhotoEye := FALSE);
    ASSERT_EQ(cell.Box_Count, 0);
END_TEST

TEST 'Spawner_Enable pulses 500ms, enforces 5s cooldown, and stays inhibited during dwell'
    (* On Start, initial spawn window opens immediately *)
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_TRUE(cell.Conveyor_Run);
    ASSERT_TRUE(cell.Spawner_Enable);

    (* After 500ms pulse, Spawner_Enable drops into 5s cooldown *)
    ADVANCE_TIME(500000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_FALSE(cell.Spawner_Enable);

    (* After 4.9s of running, still in cooldown *)
    ADVANCE_TIME(4900000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_FALSE(cell.Spawner_Enable);

    (* After full 5.0s of running, next spawn window opens *)
    ADVANCE_TIME(100000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_TRUE(cell.Spawner_Enable);

    (* Triggering Inspection Dwell mid-pulse immediately inhibits Spawner_Enable
       and forces a full 5s cooldown upon resume (preventing back-to-back touching boxes) *)
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_FALSE(cell.Conveyor_Run);
    ASSERT_FALSE(cell.Spawner_Enable);

    (* Dwell finishes and Conveyor_Run resumes, but Spawner_Enable stays FALSE for 5s *)
    ADVANCE_TIME(2000000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_TRUE(cell.Conveyor_Run);
    ASSERT_FALSE(cell.Spawner_Enable);

    ADVANCE_TIME(4900000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_FALSE(cell.Spawner_Enable);

    ADVANCE_TIME(100000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_TRUE(cell.Spawner_Enable);
END_TEST

TEST 'PhotoEye continuous block > 4s while running latches Jam Fault'
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);

    (* Complete 2s Inspection Dwell so Conveyor_Run resumes while PhotoEye stays blocked *)
    ADVANCE_TIME(2000000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_TRUE(cell.Conveyor_Run);
    ASSERT_FALSE(cell.Fault_Light);

    (* Still running at 3.9s of continuous blockage *)
    ADVANCE_TIME(3900000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_TRUE(cell.Conveyor_Run);
    ASSERT_FALSE(cell.Fault_Light);

    (* At 4.0s continuous blockage while running => Jam Fault latches *)
    ADVANCE_TIME(100000000);
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := TRUE);
    ASSERT_FALSE(cell.Conveyor_Run);
    ASSERT_FALSE(cell.Spawner_Enable);
    ASSERT_TRUE(cell.Fault_Light);

    (* Start is blocked while Jam Fault is latched *)
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_FALSE(cell.Conveyor_Run);
    ASSERT_TRUE(cell.Fault_Light);

    (* Clearing PhotoEye + pressing Reset clears Jam Fault and allows Start *)
    cell(Start_PB := FALSE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := TRUE, PhotoEye := FALSE);
    ASSERT_FALSE(cell.Fault_Light);
    cell(Start_PB := TRUE, Stop_PB := FALSE, EStop := FALSE, Reset_Count_PB := FALSE, PhotoEye := FALSE);
    ASSERT_TRUE(cell.Conveyor_Run);
END_TEST
