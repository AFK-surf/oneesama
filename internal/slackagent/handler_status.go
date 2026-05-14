package slackagent

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func (h *Handler) handleStatus(c *gin.Context) {
	c.JSON(http.StatusOK, h.service.Status())
}
