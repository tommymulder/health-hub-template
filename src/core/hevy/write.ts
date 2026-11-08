// The ONLY code that writes to Hevy. Hevy has no delete, so this client is
// deliberately simple and cautious:
//  * it never retries (a retried POST can create a duplicate that can't be removed)
//  * it tells the caller apart "Hevy refused it" (nothing written) from
//    "the request may have been sent but we never saw the answer" (unknown).

export class HevyWriteError extends Error {
  constructor(
    message: string,
    /** HTTP status, or undefined if no response ever arrived. */
    readonly status?: number,
    /** true when the request may have reached Hevy but we got no usable answer. */
    readonly unconfirmed = false,
  ) {
    super(message);
    this.name = "HevyWriteError";
  }
}

export interface RoutineSetBody {
  type: string;
  weight_kg: number | null;
  reps: number | null;
  duration_seconds: number | null;
}
export interface RoutineExerciseBody {
  exercise_template_id: string;
  superset_id: number | null;
  rest_seconds: number | null;
  notes: string | null;
  sets: RoutineSetBody[];
}
export interface RoutineBody {
  title: string;
  folder_id: number | null;
  notes: string | null;
  exercises: RoutineExerciseBody[];
}

// A FINISHED workout (POST /v1/workouts). Hevy has no delete, so these are as permanent as routines.
export interface WorkoutSetBody {
  type: string;
  weight_kg: number | null;
  reps: number | null;
  duration_seconds: number | null;
  distance_meters: number | null;
  custom_metric: number | null;
  rpe: number | null; // only 6, 7, 7.5, 8, 8.5, 9, 9.5, 10 are accepted
}
export interface WorkoutExerciseBody {
  exercise_template_id: string;
  superset_id: number | null; // exercises sharing an id form a superset (they must be adjacent)
  notes: string | null;
  sets: WorkoutSetBody[];
}
export interface WorkoutBody {
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  is_private: boolean;
  exercises: WorkoutExerciseBody[];
}

// A custom exercise (POST /v1/exercise_templates). It can never be edited or deleted afterwards, and there is a per-account limit.
export interface CustomExerciseBody {
  title: string;
  exercise_type: string; // weight_reps | reps_only | bodyweight_reps | bodyweight_assisted_reps | duration | weight_duration | distance_duration | short_distance_weight
  equipment_category: string;
  muscle_group: string;
  other_muscles: string[];
}

export interface HevyWriteApi {
  createWorkout(body: WorkoutBody): Promise<{ raw: unknown }>;
  createExerciseTemplate(body: CustomExerciseBody): Promise<{ raw: unknown }>;
  listRoutineFolders(): Promise<{ id: number; title: string }[]>;
  getRoutine(id: string): Promise<unknown>;
  createRoutineFolder(title: string): Promise<{ raw: unknown }>;
  createRoutine(body: RoutineBody): Promise<{ raw: unknown }>;
  updateRoutine(id: string, body: RoutineBody): Promise<{ raw: unknown }>;
}

export interface WriterOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createHevyWriter(opts: WriterOptions): HevyWriteApi {
  const base = opts.baseUrl ?? "https://api.hevyapp.com";
  const doFetch = opts.fetchImpl ?? fetch;

  async function send(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(new URL(path, base), {
        method,
        headers: {
          "api-key": opts.apiKey,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      // No response: for a write we cannot know whether Hevy received it.
      throw new HevyWriteError(`No response from Hevy (${(err as Error).message})`, undefined, method !== "GET");
    }

    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }

    if (!res.ok) {
      const detail = typeof json === "object" && json && "error" in json ? String((json as { error: unknown }).error) : "";
      const msg =
        res.status === 403 ? `Hevy refused (403)${detail ? `: ${detail}` : ""}. This usually means an account limit was reached (${path.includes("exercise_templates") ? "custom exercises" : "routines"}).`
        : res.status === 404 ? "Hevy says that routine doesn't exist (it may have been deleted in the app)."
        : res.status === 400 ? `Hevy rejected the request as invalid${detail ? `: ${detail}` : ""}.`
        : res.status === 401 ? "Hevy rejected the API key (401)."
        : `Hevy returned an error (${res.status})${detail ? `: ${detail}` : ""}.`;
      // 5xx on a write: the server may have acted before failing, so treat as unconfirmed.
      throw new HevyWriteError(msg, res.status, method !== "GET" && res.status >= 500);
    }
    return json;
  }

  return {
    async listRoutineFolders() {
      const out: { id: number; title: string }[] = [];
      for (let page = 1; ; page++) {
        const r = (await send("GET", `/v1/routine_folders?page=${page}&pageSize=10`)) as
          { page_count?: number; routine_folders?: { id: number; title: string }[] } | null;
        for (const f of r?.routine_folders ?? []) out.push({ id: f.id, title: f.title });
        if (page >= (r?.page_count ?? 1)) return out;
      }
    },
    getRoutine: (id) => send("GET", `/v1/routines/${encodeURIComponent(id)}`),
    createRoutineFolder: async (title) => ({ raw: await send("POST", "/v1/routine_folders", { routine_folder: { title } }) }),
    createRoutine: async (body) => ({ raw: await send("POST", "/v1/routines", { routine: body }) }),
    createWorkout: async (body) => ({ raw: await send("POST", "/v1/workouts", { workout: body }) }),
    createExerciseTemplate: async (body) => ({ raw: await send("POST", "/v1/exercise_templates", { exercise: body }) }),
    updateRoutine: async (id, body) => ({ raw: await send("PUT", `/v1/routines/${encodeURIComponent(id)}`, { routine: body }) }),
  };
}
