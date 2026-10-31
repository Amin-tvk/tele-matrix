// Android phones often run an older built-in WebView (Chrome 113 and earlier) that lacks newer JavaScript.
// Imported first by the page and by the Matrix worker

type Resolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const PromiseWithResolvers = Promise as PromiseConstructor & { withResolvers?: <T>() => Resolvers<T> };

if (!PromiseWithResolvers.withResolvers) {
  PromiseWithResolvers.withResolvers = function withResolvers<T>() {
    let resolve!: Resolvers<T>['resolve'];
    let reject!: Resolvers<T>['reject'];
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

export {};
