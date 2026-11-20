interface Env {
  MIDI_BUCKET: R2Bucket;
  SONGS_DB: D1Database;
  MERRY_BELLS_ACCESS_CODE: string;
}

interface SongInput {
  title?: unknown;
  bpm?: unknown;
  melodyEvents?: unknown;
  harmonyEvents?: unknown;
}

interface SongRow {
  id: string;
  title: string;
  original_filename: string;
  song_data: string;
  created_at: string;
}

interface StoredSongPaths {
  object_path: string;
  backing_track_path: string | null;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const allowedExtensions = new Set(['mid', 'midi', 'musicxml', 'xml']);
const maxFileSize = 4 * 1024 * 1024;
const maxSongDataBytes = 1024 * 1024;
const maxNoteCount = 100_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function cleanEvents(events: unknown): Array<{ midi: number; beat: number; dur: number }> {
  if (!Array.isArray(events) || events.length > maxNoteCount) {
    throw new Error('The parsed song contains too many notes.');
  }
  return events.map((event) => {
    if (!event || typeof event !== 'object') throw new Error('Invalid note data.');
    const note = event as Record<string, unknown>;
    const midi = Number(note.midi);
    const beat = Number(note.beat);
    const dur = Number(note.dur);
    if (
      !Number.isInteger(midi) || midi < 0 || midi > 127 ||
      !Number.isFinite(beat) || beat < 0 ||
      !Number.isFinite(dur) || dur <= 0
    ) {
      throw new Error('Invalid note data.');
    }
    return { midi, beat, dur };
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (new URL(request.url).pathname !== '/api/midi-library') {
      return jsonResponse({ error: 'Not found.' }, 404);
    }
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
    if (!env.MERRY_BELLS_ACCESS_CODE) {
      return jsonResponse({ error: 'Shared library storage is not configured on the server.' }, 503);
    }

    let action: string;
    let accessCode: string;
    let songId = '';
    let uploadFile: File | null = null;
    let songInput: SongInput | null = null;
    try {
      if (request.headers.get('content-type')?.includes('multipart/form-data')) {
        const form = await request.formData();
        action = String(form.get('action') || '');
        accessCode = String(form.get('accessCode') || '');
        const file = form.get('file');
        uploadFile = file instanceof File ? file : null;
        const song = form.get('song');
        songInput = typeof song === 'string' ? JSON.parse(song) : null;
      } else {
        const body = await request.json() as { action?: unknown; accessCode?: unknown; songId?: unknown };
        action = String(body?.action || '');
        accessCode = String(body?.accessCode || '');
        songId = String(body?.songId || '');
      }
    } catch {
      return jsonResponse({ error: 'Invalid request data.' }, 400);
    }

    if (accessCode.length > 256) return jsonResponse({ error: 'The access code is too long.' }, 400);
    if (accessCode !== env.MERRY_BELLS_ACCESS_CODE) {
      return jsonResponse({ error: 'That shared access code is not correct.' }, 401);
    }
    if (action === 'verify') return jsonResponse({ ok: true });

    if (action === 'list') {
      try {
        const result = await env.SONGS_DB.prepare(
          'SELECT id, title, original_filename, song_data, created_at FROM midi_songs ORDER BY created_at DESC',
        ).all<SongRow>();
        return jsonResponse({
          songs: result.results.map((row) => ({
            ...row,
            song_data: JSON.parse(row.song_data),
          })),
        });
      } catch (error) {
        console.error('Could not load the shared song library.', error);
        return jsonResponse({ error: 'Could not load shared songs.' }, 500);
      }
    }

    if (action === 'delete') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(songId)) {
        return jsonResponse({ error: 'Invalid song ID.' }, 400);
      }

      let storedPaths: StoredSongPaths | null;
      try {
        storedPaths = await env.SONGS_DB.prepare(
          'SELECT object_path, backing_track_path FROM midi_songs WHERE id = ?',
        ).bind(songId).first<StoredSongPaths>();
      } catch (error) {
        console.error('Could not look up the shared song to delete.', error);
        return jsonResponse({ error: 'Could not find the shared song.' }, 500);
      }
      if (!storedPaths) return jsonResponse({ error: 'That shared song no longer exists.' }, 404);

      try {
        await env.MIDI_BUCKET.delete(storedPaths.object_path);
        if (storedPaths.backing_track_path) {
          await env.MIDI_BUCKET.delete(storedPaths.backing_track_path);
        }
      } catch (error) {
        console.error('Could not remove the shared song files from R2.', error);
        return jsonResponse({ error: 'Could not remove the song files from storage. The song remains in the library.' }, 502);
      }

      try {
        await env.SONGS_DB.prepare('DELETE FROM midi_songs WHERE id = ?').bind(songId).run();
      } catch (error) {
        console.error('Could not remove the shared song record from D1.', error);
        return jsonResponse({ error: 'The song files were removed, but its library record could not be deleted. Try again.' }, 502);
      }

      return jsonResponse({ ok: true });
    }

    if (action !== 'upload' || !uploadFile || !songInput) {
      return jsonResponse({ error: 'Invalid upload request.' }, 400);
    }
    if (uploadFile.size === 0 || uploadFile.size > maxFileSize) {
      return jsonResponse({ error: 'MIDI and MusicXML files must be between 1 byte and 4 MB.' }, 413);
    }
    const extension = uploadFile.name.split('.').pop()?.toLowerCase() || '';
    if (!allowedExtensions.has(extension)) {
      return jsonResponse({ error: 'Only MIDI and MusicXML files are supported.' }, 415);
    }

    let songData: Record<string, unknown>;
    const title = String(songInput.title || '').trim().slice(0, 160);
    const bpm = Number(songInput.bpm) || 120;
    try {
      if (!title) throw new Error('The uploaded song needs a title.');
      songData = {
        title,
        bpm: Math.min(400, Math.max(20, bpm)),
        rangeMode: '13',
        complexity: 'melody',
        transpose: 0,
        melodyEvents: cleanEvents(songInput.melodyEvents),
        harmonyEvents: cleanEvents(songInput.harmonyEvents),
        lyrics: [],
      };
      if (new TextEncoder().encode(JSON.stringify(songData)).length > maxSongDataBytes) {
        throw new Error('The parsed song is too large to save.');
      }
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : 'Could not process this upload.',
      }, 400);
    }

    const id = crypto.randomUUID();
    const objectPath = `${id}.${extension}`;
    const contentType = extension === 'mid' || extension === 'midi'
      ? 'audio/midi'
      : 'application/xml';
    try {
      await env.MIDI_BUCKET.put(objectPath, uploadFile.stream(), {
        httpMetadata: { contentType },
      });
    } catch (error) {
      console.error('Could not store original upload in R2.', error);
      return jsonResponse({ error: 'Could not store the original file.' }, 502);
    }

    try {
      await env.SONGS_DB.prepare(
        'INSERT INTO midi_songs (id, title, original_filename, object_path, song_data) VALUES (?, ?, ?, ?, ?)',
      ).bind(
        id,
        title,
        uploadFile.name.slice(0, 255),
        objectPath,
        JSON.stringify(songData),
      ).run();
    } catch (error) {
      try {
        await env.MIDI_BUCKET.delete(objectPath);
      } catch (cleanupError) {
        console.error('Could not remove the unregistered R2 upload.', cleanupError);
        return jsonResponse({ error: 'Song details could not be saved, and the original file could not be cleaned up.' }, 502);
      }
      console.error('Could not save uploaded song details in D1.', error);
      return jsonResponse({ error: 'Could not save song details. The uploaded file was removed.' }, 502);
    }

    return jsonResponse({
      song: {
        id,
        title,
        original_filename: uploadFile.name.slice(0, 255),
        song_data: songData,
      },
    }, 201);
  },
};
