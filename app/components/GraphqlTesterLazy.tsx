import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import "./graphql-tester.css";

type GraphqlTesterProps = {
  defaultQuery: string;
};

export function GraphqlTesterLazy({
  defaultQuery,
}: GraphqlTesterProps) {
  const [Tester, setTester] = useState<ComponentType<
    GraphqlTesterProps
  > | null>(null);

  useEffect(() => {
    let active = true;

    void import("./GraphqlTester").then(
      (module) => {
        if (active) {
          setTester(() => module.GraphqlTester);
        }
      },
    );

    return () => {
      active = false;
    };
  }, []);

  if (!Tester) {
    return (
      <div className="graphql-tester-loading">
        Loading GraphiQL editor…
      </div>
    );
  }

  return <Tester defaultQuery={defaultQuery} />;
}
