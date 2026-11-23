FUNCTION_BLOCK ConveyorCellController
  VAR_INPUT
    Start_PB       : BOOL;
    Stop_PB        : BOOL;
    EStop          : BOOL;
    Reset_Count_PB : BOOL;
    PhotoEye       : BOOL;
  END_VAR
  VAR_OUTPUT
    Conveyor_Run   : BOOL;
    Spawner_Enable : BOOL;
    Run_Light      : BOOL;
    Dwell_Light    : BOOL;
    Fault_Light    : BOOL;
    Box_Count      : INT := 0;
  END_VAR
  VAR CONSTANT
    BATCH_TARGET        : INT  := 5;
    DWELL_TIME          : TIME := T#2s;
    JAM_THRESHOLD_TIME  : TIME := T#4s;
    SPAWN_PULSE_TIME    : TIME := T#500ms;
    SPAWN_COOLDOWN_TIME : TIME := T#5s;
  END_VAR
  VAR
    System_Running        : BOOL := FALSE;
    Dwell_Active          : BOOL := FALSE;
    Jam_Fault             : BOOL := FALSE;
    Fault_Active          : BOOL := FALSE;
    Spawn_Pulse_Active    : BOOL := FALSE;
    Spawn_Cooldown_Active : BOOL := FALSE;
    Start_Trig            : R_TRIG;
    PhotoEye_Trig         : R_TRIG;
    Dwell_Timer           : TON;
    Jam_Timer             : TON;
    Spawn_Pulse_Timer     : TON;
    Spawn_Cooldown_Timer  : TON;
  END_VAR

  (* Rising-edge detection on Start_PB and Photo-Eye *)
  Start_Trig(CLK := Start_PB);
  PhotoEye_Trig(CLK := PhotoEye);

  (* Clear latched Jam Fault when Photo-Eye is clear and operator resets or stops *)
  IF Jam_Fault AND NOT PhotoEye AND NOT EStop AND (Reset_Count_PB OR Stop_PB) THEN
    Jam_Fault := FALSE;
  END_IF;

  (* Safety E-Stop and Stop button immediately halt Cell *)
  IF EStop OR Stop_PB THEN
    System_Running := FALSE;
    Dwell_Active := FALSE;
  END_IF;

  Fault_Active := EStop OR Jam_Fault;

  (* Reset Batch counter only while Cell is stopped *)
  IF Reset_Count_PB AND NOT System_Running THEN
    Box_Count := 0;
  END_IF;

  (* Start push button rising edge latches Cell when clear of faults and Batch not full *)
  IF Start_Trig.Q AND NOT Stop_PB AND NOT Fault_Active AND (Box_Count < BATCH_TARGET) THEN
    System_Running := TRUE;
  END_IF;

  (* Box arrival: increment Batch count; halt on Batch target, else enter Inspection Dwell *)
  IF System_Running AND PhotoEye_Trig.Q THEN
    Box_Count := Box_Count + 1;
    IF Box_Count >= BATCH_TARGET THEN
      System_Running := FALSE;
      Dwell_Active := FALSE;
    ELSE
      Dwell_Active := TRUE;
    END_IF;
  END_IF;

  (* 2-second Inspection Dwell timer *)
  Dwell_Timer(IN := System_Running AND Dwell_Active, PT := DWELL_TIME);
  IF Dwell_Timer.Q THEN
    Dwell_Active := FALSE;
    Dwell_Timer(IN := FALSE, PT := DWELL_TIME);
  END_IF;

  (* Jam Fault: Photo-Eye continuously blocked beyond threshold while conveyor is running *)
  Jam_Timer(IN := System_Running AND NOT Dwell_Active AND PhotoEye, PT := JAM_THRESHOLD_TIME);
  IF Jam_Timer.Q THEN
    Jam_Fault := TRUE;
    System_Running := FALSE;
    Dwell_Active := FALSE;
    Jam_Timer(IN := FALSE, PT := JAM_THRESHOLD_TIME);
  END_IF;

  Fault_Active := EStop OR Jam_Fault;

  (* Core actuator and indicator outputs *)
  Conveyor_Run := System_Running AND NOT Dwell_Active AND NOT Fault_Active;
  Run_Light    := System_Running AND NOT Fault_Active;
  Dwell_Light  := System_Running AND Dwell_Active AND NOT Fault_Active;
  Fault_Light  := Fault_Active;

  (* Anti-touching box spawner gating: inhibited whenever Conveyor_Run is FALSE,
     pulsed for 500ms, then held off for a 5s running cooldown.
     If Conveyor_Run drops mid-pulse (e.g., Inspection Dwell), transition into cooldown
     so resuming never fires a back-to-back spawn pulse. *)
  IF NOT Conveyor_Run THEN
    IF Spawn_Pulse_Active THEN
      Spawn_Pulse_Active := FALSE;
      Spawn_Cooldown_Active := TRUE;
    END_IF;
    Spawner_Enable := FALSE;
    Spawn_Pulse_Timer(IN := FALSE, PT := SPAWN_PULSE_TIME);
    Spawn_Cooldown_Timer(IN := FALSE, PT := SPAWN_COOLDOWN_TIME);
  ELSIF NOT Spawn_Cooldown_Active THEN
    Spawn_Pulse_Active := TRUE;
    Spawn_Pulse_Timer(IN := TRUE, PT := SPAWN_PULSE_TIME);
    IF Spawn_Pulse_Timer.Q THEN
      Spawn_Pulse_Active := FALSE;
      Spawn_Cooldown_Active := TRUE;
      Spawn_Pulse_Timer(IN := FALSE, PT := SPAWN_PULSE_TIME);
      Spawn_Cooldown_Timer(IN := TRUE, PT := SPAWN_COOLDOWN_TIME);
      Spawner_Enable := FALSE;
    ELSE
      Spawner_Enable := TRUE;
    END_IF;
  ELSE
    Spawn_Cooldown_Timer(IN := TRUE, PT := SPAWN_COOLDOWN_TIME);
    IF Spawn_Cooldown_Timer.Q THEN
      Spawn_Cooldown_Active := FALSE;
      Spawn_Pulse_Active := TRUE;
      Spawn_Cooldown_Timer(IN := FALSE, PT := SPAWN_COOLDOWN_TIME);
      Spawn_Pulse_Timer(IN := TRUE, PT := SPAWN_PULSE_TIME);
      Spawner_Enable := TRUE;
    ELSE
      Spawner_Enable := FALSE;
    END_IF;
  END_IF;
END_FUNCTION_BLOCK

PROGRAM ConveyorCellMain
  VAR
    Start_PB       AT %IX0.0 : BOOL;
    Stop_PB        AT %IX0.1 : BOOL;
    EStop          AT %IX0.2 : BOOL;
    Reset_Count_PB AT %IX0.3 : BOOL;
    PhotoEye       AT %IX0.4 : BOOL;

    Conveyor_Run   AT %QX0.0 : BOOL;
    Spawner_Enable AT %QX0.1 : BOOL;
    Run_Light      AT %QX0.2 : BOOL;
    Dwell_Light    AT %QX0.3 : BOOL;
    Fault_Light    AT %QX0.4 : BOOL;
    Box_Count      AT %QW0   : INT;

    Controller : ConveyorCellController;
  END_VAR

  Controller(
    Start_PB       := Start_PB,
    Stop_PB        := Stop_PB,
    EStop          := EStop,
    Reset_Count_PB := Reset_Count_PB,
    PhotoEye       := PhotoEye
  );

  Conveyor_Run   := Controller.Conveyor_Run;
  Spawner_Enable := Controller.Spawner_Enable;
  Run_Light      := Controller.Run_Light;
  Dwell_Light    := Controller.Dwell_Light;
  Fault_Light    := Controller.Fault_Light;
  Box_Count      := Controller.Box_Count;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : ConveyorCellMain;
  END_RESOURCE
END_CONFIGURATION
