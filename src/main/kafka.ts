import { Kafka, Partitioners, type Producer } from "kafkajs";
import type { AppEvent, EventSink } from "./events";
import { createLogger } from "./logger";

const log = createLogger("kafka");

type KafkaEventPublisherConfig = {
  brokers: string[];
  clientId: string;
  enabled: boolean;
  topic: string;
};

const parseBrokers = (value?: string): string[] =>
  (value ?? "localhost:9092")
    .split(",")
    .map((broker) => broker.trim())
    .filter(Boolean);

const getKafkaConfig = (): KafkaEventPublisherConfig => ({
  brokers: parseBrokers(process.env.KAFKA_BROKERS),
  clientId: process.env.KAFKA_CLIENT_ID ?? "blueberry-browser",
  enabled: process.env.KAFKA_ENABLED !== "false",
  topic: process.env.KAFKA_TOPIC ?? "blueberry.ipc.events",
});

export class KafkaEventPublisher {
  private producer: Producer | null = null;
  private isConnected = false;
  private readonly config = getKafkaConfig();

  private createKafka = (): Kafka =>
    new Kafka({
      clientId: this.config.clientId,
      brokers: this.config.brokers,
      connectionTimeout: 1000,
      requestTimeout: 1000,
      retry: { retries: 0 },
    });

  connect = async (): Promise<void> => {
    if (!this.config.enabled || this.isConnected) return;

    const kafka = this.createKafka();

    this.producer = kafka.producer({
      createPartitioner: Partitioners.LegacyPartitioner,
    });

    try {
      await this.producer.connect();
      this.isConnected = true;
      log.info(
        { brokers: this.config.brokers, topic: this.config.topic },
        "Kafka event publishing enabled",
      );
    } catch (error) {
      this.producer = null;
      log.warn({ err: error }, "Kafka event publishing disabled");
    }
  };

  publish: EventSink = (event: AppEvent): void => {
    if (!this.producer || !this.isConnected) return;

    void this.producer
      .send({
        topic: this.config.topic,
        messages: [
          {
            key: event.channel,
            value: JSON.stringify(event),
          },
        ],
      })
      .catch((error) => {
        log.error({ err: error }, "Failed to publish Kafka event");
      });
  };

  disconnect = async (): Promise<void> => {
    if (!this.producer || !this.isConnected) return;

    await this.producer.disconnect();
    this.isConnected = false;
    this.producer = null;
  };
}

export const createKafkaEventPublisher = (): KafkaEventPublisher =>
  new KafkaEventPublisher();
