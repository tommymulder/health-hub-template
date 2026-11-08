import type { CustomExerciseBody, HevyWriteApi, WorkoutBody } from "@/core/hevy/write";

// A FAKE Hevy writer for tests: records what would have been sent and answers like Hevy does. It can never reach Hevy.
export function fakeWriter() {
  const calls = { workouts: [] as WorkoutBody[], templates: [] as CustomExerciseBody[] };
  const writer: HevyWriteApi = {
    listRoutineFolders: async () => [], getRoutine: async () => ({}),
    createRoutineFolder: async () => { throw new Error("unused"); }, createRoutine: async () => { throw new Error("unused"); }, updateRoutine: async () => { throw new Error("unused"); },
    createExerciseTemplate: async (b) => { calls.templates.push(b); throw new Error("no custom exercises in these tests"); },
    createWorkout: async (b) => {
      calls.workouts.push(b);
      const id = `hw-${calls.workouts.length}-${b.start_time.slice(0, 10)}`;
      return { raw: { workout: [{ id, title: b.title, description: b.description, start_time: b.start_time, end_time: b.end_time, updated_at: b.end_time, created_at: b.end_time,
        exercises: b.exercises.map((e, i) => ({ index: i, title: e.exercise_template_id, exercise_template_id: e.exercise_template_id, superset_id: e.superset_id, notes: e.notes,
          sets: e.sets.map((s, j) => ({ index: j, ...s })) })) }] } };
    },
  };
  return { writer, calls };
}
