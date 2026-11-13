# Modified for Triune.
"""Artifact store — blob storage for agent bundles and user files."""

from abc import ABC, abstractmethod


class ArtifactStore(ABC):
    """
    Blob storage for binary artifacts (agent bundles, user-uploaded
    files). Keyed by a unique string identifier. Metadata (filename,
    size, etc.) is managed separately by the route layer.
    """

    def __init__(self, storage_location: str) -> None:
        """
        Initialize the store with a backend-specific storage location.

        The interpretation of *storage_location* depends on the
        concrete implementation -- e.g. a filesystem path for local
        storage, an S3 URI for cloud storage, etc.

        :param storage_location: Backend-specific root location,
            e.g. ``"/data/artifacts"`` for local filesystem or
            ``"s3://my-bucket/artifacts"`` for S3.
        """
        self._storage_location = storage_location

    @property
    def storage_location(self) -> str:
        """
        The backend-specific storage location (path, URI, etc.).

        :returns: The storage location string passed at init.
        """
        return self._storage_location

    @abstractmethod
    def put(self, key: str, data: bytes) -> None:
        """
        Store a blob under the given key. Overwrites if the key
        already exists.

        :param key: Forward-slash-separated artifact key,
            e.g. ``"agents/agent_abc123/bundle.tar.gz"``.
        :param data: Raw bytes to store.
        """
        ...

    def put_if_absent(self, key: str, data: bytes) -> bool:
        """Atomically publish a complete blob, returning False if the key exists.

        True means the complete blob is visible to all readers.
        False leaves the existing blob unchanged.
        A failed remote response may require checking whether publication committed.
        Older custom backends retain their existing API; capture publication
        requires an implementation that can guarantee atomic creation.
        """
        raise NotImplementedError("Artifact backend does not support atomic publication")

    @abstractmethod
    def get(self, key: str) -> bytes:
        """
        Retrieve a blob by key.

        :param key: Forward-slash-separated artifact key,
            e.g. ``"agents/agent_abc123/bundle.tar.gz"``.
        :returns: The raw bytes of the stored blob.
        :raises KeyError: If no blob exists for the given key.
        """
        ...

    @abstractmethod
    def delete(self, key: str) -> None:
        """
        Remove a blob. No-op if the key does not exist.

        :param key: Forward-slash-separated artifact key,
            e.g. ``"agents/agent_abc123/bundle.tar.gz"``.
        """
        ...

    @abstractmethod
    def exists(self, key: str) -> bool:
        """
        Check whether a blob exists for the given key.

        :param key: Forward-slash-separated artifact key,
            e.g. ``"agents/agent_abc123/bundle.tar.gz"``.
        :returns: ``True`` if a blob exists, ``False`` otherwise.
        """
        ...
