/**
 * Handler for debug endpoint
 */
import { Request, Response } from "express";

export default function(req: Request, res: Response) {
  res.json({
    env: process.env,
    headers: req.headers,
  });
}