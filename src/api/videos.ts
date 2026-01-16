import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { s3, type BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { mediaTypeToExt } from "./assets";
import { randomBytes } from "node:crypto";
import path from "node:path";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video id");
  }

  const MAX_UPLOAD_SIZE = 1 << 30;

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new Error("couldn't find video");
  }

  if (userID !== video.userID) {
    throw new UserForbiddenError("not authorized to upload video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video file exceeds the maximum allowed size of 1GB");
  }

  const mediaType = file.type;
  if (!mediaType) {
    throw new BadRequestError("Missing Content-Type for video");
  }

  if (mediaType !== "video/mp4") {
    throw new BadRequestError("Invalid file type");
  }

    const ext = mediaTypeToExt(mediaType);
    const filename = `${randomBytes(32).toString("hex")}${ext}`;
  
    const tempPath = path.join("/tmp/", filename)
    await Bun.write(tempPath, file);
    const aspectRatio = await getVideoAspectRatio(tempPath);
    const processedVideoPath = await processVideoForFastStart(tempPath);

    const s3File = cfg.s3Client.file(`${aspectRatio}/${filename}`);
    await s3File.write(Bun.file(processedVideoPath), {
      type: mediaType
    });

    const videoURL = `https://${cfg.s3CfDistribution}/${aspectRatio}/${filename}`;
    video.videoURL = videoURL;
    updateVideo(cfg.db, video);
    await Bun.file(tempPath).delete();
    await Bun.file(processedVideoPath).delete();
    return respondWithJSON(200, video);
}

async function getVideoAspectRatio(filepath: string) {
    const proc = Bun.spawn([
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filepath
    ], {
      stdout: "pipe",
      stderr: "pipe"
    });

    if (await proc.exited !== 0) {
      throw new Error("something wrong with Bun.spawn");
    }

    const stdoutText = await new Response(proc.stdout).text();
    const stderrText = await new Response(proc.stderr).text();

    if (stderrText) {
      throw new Error("Error in reading stream");
    }

    const parsedStdout = JSON.parse(stdoutText);

    const landscapeRatio = Math.floor(16 / 9);
    const portraitRatio = Math.floor(9 / 16);

    if (Math.floor(parsedStdout.streams[0].width / parsedStdout.streams[0].height) === landscapeRatio) {
      return "landscape";
    } else if (Math.floor(parsedStdout.streams[0].width / parsedStdout.streams[0].height) === portraitRatio) {
      return "portrait";
    } else {
      return "other";
    }
}

async function processVideoForFastStart(inputFilePath: string) {
    const outputFilePath = `${inputFilePath}.processed`;
    const proc = Bun.spawn([
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath
    ], {
      stdout: "pipe",
      stderr: "pipe"
    });

    if (await proc.exited !== 0) {
      throw new Error(`Error in encoding video: ${await new Response(proc.stderr).text()}`);
    }

    return outputFilePath;
}