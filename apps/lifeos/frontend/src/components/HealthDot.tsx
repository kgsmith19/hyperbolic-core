import { useQuery } from "@tanstack/react-query";

import { health } from "../api/client";

export default function HealthDot() {
  const { isSuccess } = useQuery({
    queryKey: ["health"],
    queryFn: health,
    refetchInterval: 60_000,
  });
  return (
    <span
      title={isSuccess ? "API healthy" : "API unreachable"}
      className={`inline-block h-2.5 w-2.5 rounded-full ${isSuccess ? "bg-green-500" : "bg-red-400"}`}
    />
  );
}
